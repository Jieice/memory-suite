package poller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type clientFunc func(*http.Request) (*http.Response, error)

func (f clientFunc) Do(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestPollSucceedsAfterRetries(t *testing.T) {
	statuses := []int{202, 202, 200}
	var requests []*http.Request
	var sleeps []time.Duration

	response, err := Poll(context.Background(), Options{
		URL: "https://example.test/status",
		NewRequest: func(ctx context.Context, url string) (*http.Request, error) {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				return nil, err
			}
			request.Header.Set("X-Test", "poll")
			return request, nil
		},
		Client: clientFunc(func(request *http.Request) (*http.Response, error) {
			requests = append(requests, request)
			status := statuses[len(requests)-1]
			return httpResponse(status, "status"), nil
		}),
		IsSuccess: func(response *http.Response) (bool, error) {
			return response.StatusCode == http.StatusOK, nil
		},
		MaxRetries:     3,
		Timeout:        time.Second,
		InitialBackoff: 10 * time.Millisecond,
		MaxBackoff:     100 * time.Millisecond,
		Sleep: func(_ context.Context, delay time.Duration) error {
			sleeps = append(sleeps, delay)
			return nil
		},
		Rand: func() float64 {
			return 0.5
		},
	})
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if len(requests) != 3 {
		t.Fatalf("request count = %d, want 3", len(requests))
	}
	for _, request := range requests {
		if request.URL.String() != "https://example.test/status" {
			t.Fatalf("request URL = %s", request.URL.String())
		}
		if request.Header.Get("X-Test") != "poll" {
			t.Fatal("request constructor header was not applied")
		}
	}

	wantSleeps := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}
	if len(sleeps) != len(wantSleeps) {
		t.Fatalf("sleep count = %d, want %d", len(sleeps), len(wantSleeps))
	}
	for index := range wantSleeps {
		if sleeps[index] != wantSleeps[index] {
			t.Fatalf("sleep[%d] = %s, want %s", index, sleeps[index], wantSleeps[index])
		}
	}
}

func TestPollReturnsFinalResponseWhenRetriesExceeded(t *testing.T) {
	response, err := Poll(context.Background(), Options{
		URL: "https://example.test/status",
		Client: clientFunc(func(*http.Request) (*http.Response, error) {
			return httpResponse(http.StatusAccepted, "pending"), nil
		}),
		MaxRetries:     1,
		Timeout:        time.Second,
		InitialBackoff: time.Millisecond,
		Sleep: func(context.Context, time.Duration) error {
			return nil
		},
	})
	if !errors.Is(err, ErrMaxRetriesExceeded) {
		t.Fatalf("error = %v, want ErrMaxRetriesExceeded", err)
	}
	if response == nil {
		t.Fatal("expected final response")
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", response.StatusCode)
	}
}

func TestPollTimeoutDuringBackoff(t *testing.T) {
	_, err := Poll(context.Background(), Options{
		URL: "https://example.test/status",
		Client: clientFunc(func(*http.Request) (*http.Response, error) {
			return httpResponse(http.StatusAccepted, "pending"), nil
		}),
		MaxRetries:     3,
		Timeout:        time.Second,
		InitialBackoff: time.Millisecond,
		Sleep: func(context.Context, time.Duration) error {
			return context.DeadlineExceeded
		},
	})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("error = %v, want ErrTimeout", err)
	}
}

func TestPollPropagatesSuccessPredicateError(t *testing.T) {
	predicateErr := errors.New("bad response")
	response, err := Poll(context.Background(), Options{
		URL: "https://example.test/status",
		Client: clientFunc(func(*http.Request) (*http.Response, error) {
			return httpResponse(http.StatusOK, "ok"), nil
		}),
		IsSuccess: func(*http.Response) (bool, error) {
			return false, predicateErr
		},
		MaxRetries: 0,
		Timeout:    time.Second,
	})
	if !errors.Is(err, predicateErr) {
		t.Fatalf("error = %v, want predicate error", err)
	}
	if response == nil {
		t.Fatal("expected response to be returned with predicate error")
	}
	defer response.Body.Close()
}

func TestPollRequestErrorRetriesThenFails(t *testing.T) {
	requestErr := errors.New("network unavailable")
	var attempts int

	_, err := Poll(context.Background(), Options{
		URL: "https://example.test/status",
		Client: clientFunc(func(*http.Request) (*http.Response, error) {
			attempts++
			return nil, requestErr
		}),
		MaxRetries:     2,
		Timeout:        time.Second,
		InitialBackoff: time.Millisecond,
		Sleep: func(context.Context, time.Duration) error {
			return nil
		},
	})
	if !errors.Is(err, ErrMaxRetriesExceeded) {
		t.Fatalf("error = %v, want ErrMaxRetriesExceeded", err)
	}
	if !errors.Is(err, requestErr) {
		t.Fatalf("error = %v, want wrapped request error", err)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
}

func TestJitterDelay(t *testing.T) {
	delay := backoffDelay(1, 100*time.Millisecond, time.Second, 0.25, func() float64 {
		return 1
	})
	if delay != 250*time.Millisecond {
		t.Fatalf("delay = %s, want 250ms", delay)
	}
}

func TestInvalidOptions(t *testing.T) {
	_, err := Poll(context.Background(), Options{
		URL:        "",
		MaxRetries: 0,
		Timeout:    time.Second,
	})
	if !errors.Is(err, ErrInvalidOptions) {
		t.Fatalf("error = %v, want ErrInvalidOptions", err)
	}
}

func httpResponse(statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Status:     http.StatusText(statusCode),
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
