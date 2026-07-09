package fsm

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
)

var (
	ErrNilState          = errors.New("state is required")
	ErrNilAction         = errors.New("action is required")
	ErrInvalidState      = errors.New("state id is required")
	ErrInvalidAction     = errors.New("action name is required")
	ErrUnknownTransition = errors.New("unknown transition")
	ErrHashChainMismatch = errors.New("hash chain mismatch")
)

type State interface {
	ID() string
}

type Action interface {
	Name() string
}

type Transition func(State, Action) (State, error)

type BeforeHook func(BeforeContext) error

type AfterHook func(AfterContext) error

type Options struct {
	Transitions map[TransitionKey]Transition
	Before      []BeforeHook
	After       []AfterHook
}

type TransitionKey struct {
	StateID    string
	ActionName string
}

type BeforeContext struct {
	Index          uint64
	Current        State
	Action         Action
	InputStateHash string
}

type AfterContext struct {
	Index          uint64
	Current        State
	Action         Action
	NewState       State
	InputStateHash string
	Record         TransitionRecord
}

type TransitionRecord struct {
	Index           uint64 `json:"index"`
	InputStateID    string `json:"input_state_id"`
	ActionName      string `json:"action_name"`
	OutputStateID   string `json:"output_state_id"`
	InputStateHash  string `json:"input_state_hash"`
	OutputStateHash string `json:"output_state_hash"`
}

type TransitionResult struct {
	State  State
	Record TransitionRecord
}

type FSM struct {
	mu sync.Mutex

	transitions map[TransitionKey]Transition
	before      []BeforeHook
	after       []AfterHook

	started           bool
	nextIndex         uint64
	lastOutputStateID string
	chainHead         []byte
	history           []TransitionRecord
}

func Key(stateID, actionName string) TransitionKey {
	return TransitionKey{StateID: stateID, ActionName: actionName}
}

func New(opts Options) *FSM {
	transitions := make(map[TransitionKey]Transition, len(opts.Transitions))
	for key, transition := range opts.Transitions {
		transitions[key] = transition
	}

	before := append([]BeforeHook(nil), opts.Before...)
	after := append([]AfterHook(nil), opts.After...)

	return &FSM{
		transitions: transitions,
		before:      before,
		after:       after,
	}
}

func (f *FSM) Execute(current State, action Action) (State, error) {
	result, err := f.ExecuteRecord(current, action)
	if err != nil {
		return nil, err
	}

	return result.State, nil
}

func (f *FSM) ExecuteRecord(current State, action Action) (TransitionResult, error) {
	currentID, actionName, err := validateInput(current, action)
	if err != nil {
		return TransitionResult{}, err
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	inputStateHash, err := f.inputStateHash(currentID)
	if err != nil {
		return TransitionResult{}, err
	}

	transition, ok := f.transitions[Key(currentID, actionName)]
	if !ok {
		return TransitionResult{}, fmt.Errorf("%w: state=%q action=%q", ErrUnknownTransition, currentID, actionName)
	}

	index := f.nextIndex
	inputStateHashText := hex.EncodeToString(inputStateHash)
	beforeContext := BeforeContext{
		Index:          index,
		Current:        current,
		Action:         action,
		InputStateHash: inputStateHashText,
	}
	for _, hook := range f.before {
		if err := hook(beforeContext); err != nil {
			return TransitionResult{}, fmt.Errorf("before hook: %w", err)
		}
	}

	newState, err := transition(current, action)
	if err != nil {
		return TransitionResult{}, fmt.Errorf("transition state=%q action=%q: %w", currentID, actionName, err)
	}
	outputStateID, err := validateState(newState)
	if err != nil {
		return TransitionResult{}, fmt.Errorf("transition output: %w", err)
	}

	outputStateHash := transitionOutputHash(index, currentID, actionName, outputStateID, inputStateHash)
	record := TransitionRecord{
		Index:           index,
		InputStateID:    currentID,
		ActionName:      actionName,
		OutputStateID:   outputStateID,
		InputStateHash:  inputStateHashText,
		OutputStateHash: hex.EncodeToString(outputStateHash),
	}

	afterContext := AfterContext{
		Index:          index,
		Current:        current,
		Action:         action,
		NewState:       newState,
		InputStateHash: inputStateHashText,
		Record:         record,
	}
	for _, hook := range f.after {
		if err := hook(afterContext); err != nil {
			return TransitionResult{}, fmt.Errorf("after hook: %w", err)
		}
	}

	f.started = true
	f.nextIndex++
	f.lastOutputStateID = outputStateID
	f.chainHead = append(f.chainHead[:0], outputStateHash...)
	f.history = append(f.history, record)

	return TransitionResult{State: newState, Record: record}, nil
}

func (f *FSM) History() []TransitionRecord {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]TransitionRecord(nil), f.history...)
}

func (f *FSM) ChainHead() string {
	f.mu.Lock()
	defer f.mu.Unlock()

	if len(f.chainHead) == 0 {
		return ""
	}

	return hex.EncodeToString(f.chainHead)
}

func VerifyRecords(records []TransitionRecord) error {
	var previousOutputStateID string
	var previousOutputStateHash []byte

	for index, record := range records {
		if record.Index != uint64(index) {
			return fmt.Errorf("%w: record index %d does not match position %d", ErrHashChainMismatch, record.Index, index)
		}
		if record.InputStateID == "" {
			return fmt.Errorf("%w: input state id is empty at index %d", ErrHashChainMismatch, index)
		}
		if record.ActionName == "" {
			return fmt.Errorf("%w: action name is empty at index %d", ErrHashChainMismatch, index)
		}
		if record.OutputStateID == "" {
			return fmt.Errorf("%w: output state id is empty at index %d", ErrHashChainMismatch, index)
		}

		var expectedInputHash []byte
		if index == 0 {
			expectedInputHash = initialStateHash(record.InputStateID)
		} else {
			if record.InputStateID != previousOutputStateID {
				return fmt.Errorf("%w: input state %q does not match previous output %q at index %d", ErrHashChainMismatch, record.InputStateID, previousOutputStateID, index)
			}
			expectedInputHash = previousOutputStateHash
		}

		if record.InputStateHash != hex.EncodeToString(expectedInputHash) {
			return fmt.Errorf("%w: invalid input_state_hash at index %d", ErrHashChainMismatch, index)
		}

		expectedOutputHash := transitionOutputHash(record.Index, record.InputStateID, record.ActionName, record.OutputStateID, expectedInputHash)
		if record.OutputStateHash != hex.EncodeToString(expectedOutputHash) {
			return fmt.Errorf("%w: invalid output_state_hash at index %d", ErrHashChainMismatch, index)
		}

		previousOutputStateID = record.OutputStateID
		previousOutputStateHash = expectedOutputHash
	}

	return nil
}

func validateInput(current State, action Action) (string, string, error) {
	currentID, err := validateState(current)
	if err != nil {
		return "", "", err
	}
	if action == nil {
		return "", "", ErrNilAction
	}

	actionName := action.Name()
	if actionName == "" {
		return "", "", ErrInvalidAction
	}

	return currentID, actionName, nil
}

func validateState(state State) (string, error) {
	if state == nil {
		return "", ErrNilState
	}

	id := state.ID()
	if id == "" {
		return "", ErrInvalidState
	}

	return id, nil
}

func (f *FSM) inputStateHash(currentID string) ([]byte, error) {
	if !f.started {
		return initialStateHash(currentID), nil
	}
	if currentID != f.lastOutputStateID {
		return nil, fmt.Errorf("%w: input state %q does not match chain state %q", ErrHashChainMismatch, currentID, f.lastOutputStateID)
	}

	return append([]byte(nil), f.chainHead...), nil
}

func initialStateHash(stateID string) []byte {
	hash := sha256.New()
	hash.Write([]byte("fsm.state.v1"))
	hash.Write([]byte{0})
	hash.Write([]byte(stateID))
	return hash.Sum(nil)
}

func transitionOutputHash(index uint64, inputStateID, actionName, outputStateID string, inputStateHash []byte) []byte {
	var indexBytes [8]byte
	binary.BigEndian.PutUint64(indexBytes[:], index)

	hash := sha256.New()
	hash.Write([]byte("fsm.transition.v1"))
	hash.Write([]byte{0})
	hash.Write(indexBytes[:])
	hash.Write([]byte{0})
	hash.Write(inputStateHash)
	hash.Write([]byte{0})
	hash.Write([]byte(inputStateID))
	hash.Write([]byte{0})
	hash.Write([]byte(actionName))
	hash.Write([]byte{0})
	hash.Write([]byte(outputStateID))
	return hash.Sum(nil)
}
