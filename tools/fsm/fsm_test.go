package fsm

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

type testState string

func (s testState) ID() string {
	return string(s)
}

type testAction string

func (a testAction) Name() string {
	return string(a)
}

func TestExecuteNormalFlow(t *testing.T) {
	machine := New(Options{
		Transitions: map[TransitionKey]Transition{
			Key("draft", "submit"): func(State, Action) (State, error) {
				return testState("review"), nil
			},
			Key("review", "approve"): func(State, Action) (State, error) {
				return testState("approved"), nil
			},
		},
	})

	first, err := machine.ExecuteRecord(testState("draft"), testAction("submit"))
	if err != nil {
		t.Fatalf("execute draft submit: %v", err)
	}
	if first.State.ID() != "review" {
		t.Fatalf("first state = %q, want review", first.State.ID())
	}
	if first.Record.InputStateHash == "" {
		t.Fatal("first transition did not record input_state_hash")
	}

	second, err := machine.ExecuteRecord(first.State, testAction("approve"))
	if err != nil {
		t.Fatalf("execute review approve: %v", err)
	}
	if second.State.ID() != "approved" {
		t.Fatalf("second state = %q, want approved", second.State.ID())
	}
	if second.Record.InputStateHash != first.Record.OutputStateHash {
		t.Fatalf("hash chain did not link: input=%s previous=%s", second.Record.InputStateHash, first.Record.OutputStateHash)
	}

	history := machine.History()
	if len(history) != 2 {
		t.Fatalf("history length = %d, want 2", len(history))
	}
	if err := VerifyRecords(history); err != nil {
		t.Fatalf("verify history: %v", err)
	}
}

func TestExecuteRejectsUnknownTransition(t *testing.T) {
	machine := New(Options{
		Transitions: map[TransitionKey]Transition{
			Key("draft", "submit"): func(State, Action) (State, error) {
				return testState("review"), nil
			},
		},
	})

	_, err := machine.Execute(testState("draft"), testAction("approve"))
	if !errors.Is(err, ErrUnknownTransition) {
		t.Fatalf("error = %v, want ErrUnknownTransition", err)
	}
}

func TestHooksRunInOrder(t *testing.T) {
	var calls []string

	machine := New(Options{
		Transitions: map[TransitionKey]Transition{
			Key("draft", "submit"): func(State, Action) (State, error) {
				calls = append(calls, "transition")
				return testState("review"), nil
			},
		},
		Before: []BeforeHook{
			func(ctx BeforeContext) error {
				if ctx.InputStateHash == "" {
					t.Fatal("before hook got empty input hash")
				}
				calls = append(calls, "before-1")
				return nil
			},
			func(BeforeContext) error {
				calls = append(calls, "before-2")
				return nil
			},
		},
		After: []AfterHook{
			func(ctx AfterContext) error {
				if ctx.NewState.ID() != "review" {
					t.Fatalf("after hook state = %q, want review", ctx.NewState.ID())
				}
				if ctx.Record.InputStateHash == "" {
					t.Fatal("after hook got record with empty input hash")
				}
				calls = append(calls, "after-1")
				return nil
			},
			func(AfterContext) error {
				calls = append(calls, "after-2")
				return nil
			},
		},
	})

	if _, err := machine.Execute(testState("draft"), testAction("submit")); err != nil {
		t.Fatalf("execute: %v", err)
	}

	want := []string{"before-1", "before-2", "transition", "after-1", "after-2"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls = %#v, want %#v", calls, want)
	}
}

func TestHashChainMismatch(t *testing.T) {
	machine := New(Options{
		Transitions: map[TransitionKey]Transition{
			Key("draft", "submit"): func(State, Action) (State, error) {
				return testState("review"), nil
			},
			Key("review", "approve"): func(State, Action) (State, error) {
				return testState("approved"), nil
			},
		},
	})

	if _, err := machine.Execute(testState("draft"), testAction("submit")); err != nil {
		t.Fatalf("execute first transition: %v", err)
	}

	_, err := machine.Execute(testState("draft"), testAction("submit"))
	if !errors.Is(err, ErrHashChainMismatch) {
		t.Fatalf("error = %v, want ErrHashChainMismatch", err)
	}

	history := machine.History()
	history[0].InputStateHash = "tampered"
	if err := VerifyRecords(history); !errors.Is(err, ErrHashChainMismatch) {
		t.Fatalf("verify tampered history error = %v, want ErrHashChainMismatch", err)
	}
}

func TestExecuteIsConcurrentSafe(t *testing.T) {
	machine := New(Options{
		Transitions: map[TransitionKey]Transition{
			Key("draft", "submit"): func(State, Action) (State, error) {
				return testState("review"), nil
			},
		},
	})

	var waitGroup sync.WaitGroup
	errs := make(chan error, 2)

	for i := 0; i < 2; i++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, err := machine.Execute(testState("draft"), testAction("submit"))
			errs <- err
		}()
	}

	waitGroup.Wait()
	close(errs)

	var successCount int
	var chainMismatchCount int
	for err := range errs {
		switch {
		case err == nil:
			successCount++
		case errors.Is(err, ErrHashChainMismatch):
			chainMismatchCount++
		default:
			t.Fatalf("unexpected concurrent execute error: %v", err)
		}
	}

	if successCount != 1 || chainMismatchCount != 1 {
		t.Fatalf("success=%d chainMismatch=%d, want 1 and 1", successCount, chainMismatchCount)
	}
}
