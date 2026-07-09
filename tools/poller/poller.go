package poller

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"time"
)

var (
	ErrInvalidOptions     = errors.New("invalid poller options")
	ErrInvalidResponse    = errors.New("invalid poll response")
	ErrTimeout            = errors.New("poller timeout")
	ErrMaxRetriesExceeded = errors.New("maximum retry count exceeded")
)

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type RequestFunc func(context.Context, string) (*http.Request, error)

type SuccessFunc func(*http.Response) (bool, error)

type SleepFunc func(context.Context, time.Duration) error

type JitterFunc func() float64

type Options struct {
	URL            string
	NewRequest     RequestFunc
	IsSuccess      SuccessFunc
	Client         HTTPClient
	MaxRetries     int
	Timeout        time.Duration
	InitialBackoff time.Duration
	MaxBackoff     time.Duration
	Jitter         float64
	Sleep          SleepFunc
	Rand           JitterFunc
}

func Poll(ctx context.Context, options Options) (*http.Response, error) {
	normalized, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}

	if ctx == nil {
		ctx = context.Background()
	}

	pollCtx, cancel := context.WithTimeout(ctx, normalized.Timeout)
	defer cancel()

	totalAttempts := normalized.MaxRetries + 1
	var lastErr error

	for attempt := 0; attempt < totalAttempts; attempt++ {
		response, err := executeAttempt(pollCtx, normalized)
		if err != nil {
			lastErr = err
			if pollCtx.Err() != nil {
				return nil, fmt.Errorf("%w: %w", ErrTimeout, pollCtx.Err())
			}
		} else {
			success, err := normalized.IsSuccess(response)
			if err != nil {
				return response, fmt.Errorf("check poll success: %w", err)
			}
			if success {
				return response, nil
			}
			if attempt == totalAttempts-1 {
				return response, fmt.Errorf("%w: attempts=%d", ErrMaxRetriesExceeded, totalAttempts)
			}

			closeResponse(response)
		}

		if attempt == totalAttempts-1 {
			break
		}

		delay := backoffDelay(attempt, normalized.InitialBackoff, normalized.MaxBackoff, normalized.Jitter, normalized.Rand)
		if err := normalized.Sleep(pollCtx, delay); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return nil, fmt.Errorf("%w: %w", ErrTimeout, err)
			}

			return nil, fmt.Errorf("sleep before retry: %w", err)
		}
	}

	if pollCtx.Err() != nil {
		return nil, fmt.Errorf("%w: %w", ErrTimeout, pollCtx.Err())
	}
	if lastErr != nil {
		return nil, fmt.Errorf("%w: attempts=%d: %w", ErrMaxRetriesExceeded, totalAttempts, lastErr)
	}

	return nil, fmt.Errorf("%w: attempts=%d", ErrMaxRetriesExceeded, totalAttempts)
}

func executeAttempt(ctx context.Context, options Options) (*http.Response, error) {
	request, err := options.NewRequest(ctx, options.URL)
	if err != nil {
		return nil, fmt.Errorf("construct poll request: %w", err)
	}
	if request == nil {
		return nil, fmt.Errorf("%w: request constructor returned nil", ErrInvalidOptions)
	}

	response, err := options.Client.Do(request)
	if err != nil {
		return nil, err
	}
	if response == nil {
		return nil, ErrInvalidResponse
	}

	return response, nil
}

func normalizeOptions(options Options) (Options, error) {
	if options.URL == "" {
		return Options{}, fmt.Errorf("%w: URL is required", ErrInvalidOptions)
	}
	if options.MaxRetries < 0 {
		return Options{}, fmt.Errorf("%w: max retries must be >= 0", ErrInvalidOptions)
	}
	if options.Timeout <= 0 {
		return Options{}, fmt.Errorf("%w: timeout must be > 0", ErrInvalidOptions)
	}
	if options.InitialBackoff < 0 {
		return Options{}, fmt.Errorf("%w: initial backoff must be >= 0", ErrInvalidOptions)
	}
	if options.MaxBackoff < 0 {
		return Options{}, fmt.Errorf("%w: max backoff must be >= 0", ErrInvalidOptions)
	}
	if options.Jitter < 0 || options.Jitter > 1 {
		return Options{}, fmt.Errorf("%w: jitter must be between 0 and 1", ErrInvalidOptions)
	}

	if options.Client == nil {
		options.Client = http.DefaultClient
	}
	if options.NewRequest == nil {
		options.NewRequest = func(ctx context.Context, url string) (*http.Request, error) {
			return http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		}
	}
	if options.IsSuccess == nil {
		options.IsSuccess = func(response *http.Response) (bool, error) {
			return response.StatusCode == http.StatusOK, nil
		}
	}
	if options.InitialBackoff == 0 {
		options.InitialBackoff = 100 * time.Millisecond
	}
	if options.MaxBackoff == 0 {
		options.MaxBackoff = 5 * time.Second
	}
	if options.MaxBackoff < options.InitialBackoff {
		return Options{}, fmt.Errorf("%w: max backoff must be >= initial backoff", ErrInvalidOptions)
	}
	if options.Sleep == nil {
		options.Sleep = sleepContext
	}
	if options.Rand == nil {
		random := rand.New(rand.NewSource(time.Now().UnixNano()))
		options.Rand = random.Float64
	}

	return options, nil
}

func backoffDelay(attempt int, initial, maximum time.Duration, jitter float64, random JitterFunc) time.Duration {
	delay := initial
	for i := 0; i < attempt; i++ {
		if delay >= maximum/2 {
			delay = maximum
			break
		}
		delay *= 2
	}
	if delay > maximum {
		delay = maximum
	}
	if jitter == 0 {
		return delay
	}

	factor := 1 + ((random() * 2) - 1) * jitter
	if factor < 0 {
		factor = 0
	}

	return time.Duration(float64(delay) * factor)
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func closeResponse(response *http.Response) {
	if response == nil || response.Body == nil {
		return
	}

	io.Copy(io.Discard, response.Body)
	response.Body.Close()
}
