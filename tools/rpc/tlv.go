package rpc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	HeaderSize = 3
	MaxLength  = 1<<16 - 1
)

var (
	ErrNilReader      = errors.New("reader is required")
	ErrLengthExceeded = errors.New("TLV length exceeds parser limit")
)

type Handler func(Field) error

type Field struct {
	Tag    byte
	Length uint16
	Value  []byte
}

type Parser struct {
	handlers  map[byte]Handler
	maxLength uint16
}

type Options struct {
	Handlers  map[byte]Handler
	MaxLength uint16
}

func NewParser(options Options) *Parser {
	handlers := make(map[byte]Handler, len(options.Handlers))
	for tag, handler := range options.Handlers {
		handlers[tag] = handler
	}

	maxLength := options.MaxLength
	if maxLength == 0 {
		maxLength = MaxLength
	}

	return &Parser{
		handlers:  handlers,
		maxLength: maxLength,
	}
}

func Parse(reader io.Reader) (map[byte][]byte, error) {
	return NewParser(Options{}).Parse(reader)
}

func (p *Parser) Register(tag byte, handler Handler) {
	if p.handlers == nil {
		p.handlers = make(map[byte]Handler)
	}

	if handler == nil {
		delete(p.handlers, tag)
		return
	}

	p.handlers[tag] = handler
}

func (p *Parser) Parse(reader io.Reader) (map[byte][]byte, error) {
	if reader == nil {
		return nil, ErrNilReader
	}

	output := make(map[byte][]byte)
	header := make([]byte, HeaderSize)

	for {
		if _, err := io.ReadFull(reader, header); err != nil {
			if errors.Is(err, io.EOF) {
				return output, nil
			}
			if errors.Is(err, io.ErrUnexpectedEOF) {
				return nil, fmt.Errorf("read TLV header: %w", err)
			}

			return nil, fmt.Errorf("read TLV header: %w", err)
		}

		field := Field{
			Tag:    header[0],
			Length: binary.LittleEndian.Uint16(header[1:3]),
		}

		if field.Length > p.maxLength {
			return nil, fmt.Errorf("%w: tag=0x%02x length=%d max=%d", ErrLengthExceeded, field.Tag, field.Length, p.maxLength)
		}

		field.Value = make([]byte, field.Length)
		if _, err := io.ReadFull(reader, field.Value); err != nil {
			if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
				return nil, fmt.Errorf("read TLV value tag=0x%02x length=%d: %w", field.Tag, field.Length, io.ErrUnexpectedEOF)
			}

			return nil, fmt.Errorf("read TLV value tag=0x%02x length=%d: %w", field.Tag, field.Length, err)
		}

		output[field.Tag] = append(output[field.Tag], field.Value...)

		if handler, ok := p.handlers[field.Tag]; ok {
			handlerField := Field{
				Tag:    field.Tag,
				Length: field.Length,
				Value:  append([]byte(nil), field.Value...),
			}
			if err := handler(handlerField); err != nil {
				return nil, fmt.Errorf("handle TLV tag=0x%02x: %w", field.Tag, err)
			}
		}
	}
}
