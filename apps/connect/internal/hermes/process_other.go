//go:build !unix

package hermes

// processAlive cannot probe pids portably on this platform; gateway liveness
// stays unknown instead of blocking profile operations.
func processAlive(pid int) bool {
	return false
}
