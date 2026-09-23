package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func pause() {
	if os.Getenv("VIXO_INSTALL_NONINTERACTIVE") == "1" {
		return
	}
	fmt.Println("Press Enter to close this window...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to locate installer:", err)
		pause()
		os.Exit(1)
	}
	root := filepath.Dir(executable)
	node := filepath.Join(root, "runtime", "windows-x64", "node.exe")
	installer := filepath.Join(root, "scripts", "install.mjs")
	if _, err := os.Stat(node); err != nil {
		fmt.Fprintln(os.Stderr, "Bundled Node.js runtime is missing:", node)
		pause()
		os.Exit(1)
	}
	if _, err := os.Stat(installer); err != nil {
		fmt.Fprintln(os.Stderr, "Installer script is missing:", installer)
		pause()
		os.Exit(1)
	}
	command := exec.Command(node, installer)
	command.Dir = root
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	fmt.Println("VIXO Agent Teams Builder - Windows one-click installer")
	if err := command.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "Installation failed:", err)
		pause()
		if exit, ok := err.(*exec.ExitError); ok {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
	fmt.Println("Installation completed.")
	pause()
}
