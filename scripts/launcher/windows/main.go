package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Skillsui.exe is a tiny launcher: it starts the bundled Node runtime with the
// app server, hidden and detached, then exits. The server opens the browser.
// If Skillsui is already running, the new server detects it, reopens the page
// and exits, so double-clicking the launcher is always safe.
func main() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	dir := filepath.Dir(exe)
	node := filepath.Join(dir, "node.exe")
	server := filepath.Join(dir, "app", "server.mjs")
	if _, err := os.Stat(node); err != nil {
		return
	}
	if _, err := os.Stat(server); err != nil {
		return
	}

	cmd := exec.Command(node, server)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"SKILLSUI_ENGINE_DIR="+filepath.Join(dir, "engine"),
		"SKILLSUI_WEB_DIR="+filepath.Join(dir, "app", "web"),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008, // DETACHED_PROCESS
	}
	if err := cmd.Start(); err != nil {
		return
	}
	_ = cmd.Process.Release()
}
