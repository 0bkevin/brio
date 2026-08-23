//go:build unix

package hermes

import (
	"syscall"
)

// processAlive reports whether a pid is a live process. It is used for
// gateway.pid liveness only; Brio never signals foreign processes.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, syscall.Signal(0))
	return err == nil || err == syscall.EPERM
}
