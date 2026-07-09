module memory-suite/cmd/kiro

go 1.22

require (
	memory-suite/tools/fsm v0.0.0
	memory-suite/tools/jwe-envelope v0.0.0
	memory-suite/tools/poller v0.0.0
	memory-suite/tools/rpc v0.0.0
)

replace memory-suite/tools/fsm => ../../tools/fsm

replace memory-suite/tools/jwe-envelope => ../../tools/jwe-envelope

replace memory-suite/tools/poller => ../../tools/poller

replace memory-suite/tools/rpc => ../../tools/rpc
