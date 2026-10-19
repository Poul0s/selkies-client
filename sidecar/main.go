// tailscale-sidecar embeds a Tailscale node (tsnet) and exposes it to the Electron
// client as a local SOCKS5 proxy.
//
// stdout, one JSON object per line:
//
//	{"event":"listening","port":43211}
//	{"event":"state","state":"starting|login|connecting|approval|connected|stopped","ip":"100.x.y.z","dnsName":"host.tailnet.ts.net"}
//	{"event":"login","url":"https://login.tailscale.com/a/..."}
//	{"event":"denied","target":"host:port","reason":"..."}
//	{"event":"error","error":"..."}
//
// stdin, one JSON object per line (EOF = shut down, so the sidecar never outlives the app):
//
//	{"cmd":"allow","hosts":["host:port", ...]}   replace the destinations the proxy may reach
//	{"cmd":"logout"}                             deregister this node, then exit
//	{"cmd":"quit"}
//
// The auth key comes from -authkey or, preferably (not visible in `ps`), TS_AUTHKEY.
// Without a key, and without saved state, the interactive login URL is reported as a "login" event.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

var (
	outMu sync.Mutex
	out   = json.NewEncoder(os.Stdout)
)

func emit(v map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	out.Encode(v)
}

func fatal(err error) {
	emit(map[string]any{"event": "error", "error": err.Error()})
	emit(map[string]any{"event": "state", "state": "stopped"})
	os.Exit(1)
}

// peerResolver resolves a MagicDNS name (FQDN, short name or hostname) against the
// tailnet's peers only; the system DNS is never consulted.
func peerResolver(lc *local.Client) func(ctx context.Context, name string) (netip.Addr, bool) {
	return func(ctx context.Context, name string) (netip.Addr, bool) {
		st, err := lc.Status(ctx)
		if err != nil {
			return netip.Addr{}, false
		}
		for _, p := range st.Peer {
			fqdn := strings.TrimSuffix(strings.ToLower(p.DNSName), ".")
			short, _, _ := strings.Cut(fqdn, ".")
			if name != fqdn && name != short && name != strings.ToLower(p.HostName) {
				continue
			}
			for _, ip := range p.TailscaleIPs { // prefer IPv4
				if ip.Is4() {
					return ip, true
				}
			}
			if len(p.TailscaleIPs) > 0 {
				return p.TailscaleIPs[0], true
			}
		}
		return netip.Addr{}, false
	}
}

func main() {
	stateDir := flag.String("state-dir", "", "directory holding the node state (required)")
	hostname := flag.String("hostname", "selkies-client", "node name in the tailnet")
	authKey := flag.String("authkey", os.Getenv("TS_AUTHKEY"), "auth key (default: $TS_AUTHKEY)")
	flag.Parse()
	if *stateDir == "" {
		fatal(fmt.Errorf("-state-dir is required"))
	}
	if err := os.MkdirAll(*stateDir, 0o700); err != nil {
		fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The proxy only ever listens on loopback, on an ephemeral port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal(err)
	}

	srv := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
		AuthKey:  *authKey,
		Logf:     func(string, ...any) {},
		UserLogf: func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) },
	}
	if err := srv.Start(); err != nil {
		fatal(err)
	}
	defer srv.Close()
	lc, err := srv.LocalClient()
	if err != nil {
		fatal(err)
	}

	var running atomic.Bool
	policy := &Policy{resolve: peerResolver(lc)}
	var lastDeny atomic.Int64
	proxy := &socksServer{
		policy:  policy,
		dial:    srv.Dial,
		ready:   running.Load,
		timeout: 20 * time.Second,
		onDeny: func(target, reason string) { // at most one report per second
			if now := time.Now().UnixMilli(); now-lastDeny.Load() > 1000 {
				lastDeny.Store(now)
				emit(map[string]any{"event": "denied", "target": target, "reason": reason})
			}
		},
	}
	go proxy.serve(ctx, ln)
	emit(map[string]any{"event": "listening", "port": ln.Addr().(*net.TCPAddr).Port})
	emit(map[string]any{"event": "state", "state": "starting"})

	go watchState(ctx, lc, srv, &running)
	go readCommands(ctx, stop, lc, policy)

	<-ctx.Done()
	running.Store(false)
	emit(map[string]any{"event": "state", "state": "stopped"})
}

// watchState turns IPN notifications into "state" / "login" events.
func watchState(ctx context.Context, lc *local.Client, srv *tsnet.Server, running *atomic.Bool) {
	w, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		if ctx.Err() == nil {
			emit(map[string]any{"event": "error", "error": err.Error()})
		}
		return
	}
	defer w.Close()
	loginPending := false
	for {
		n, err := w.Next()
		if err != nil {
			if ctx.Err() == nil {
				emit(map[string]any{"event": "error", "error": "lost the connection to the Tailscale backend: " + err.Error()})
			}
			return
		}
		if n.ErrMessage != nil {
			emit(map[string]any{"event": "error", "error": *n.ErrMessage})
		}
		if n.BrowseToURL != nil {
			loginPending = true
			emit(map[string]any{"event": "login", "url": *n.BrowseToURL})
			emit(map[string]any{"event": "state", "state": "login"})
		}
		if n.State == nil {
			continue
		}
		running.Store(*n.State == ipn.Running)
		switch *n.State {
		case ipn.Running:
			loginPending = false
			ev := map[string]any{"event": "state", "state": "connected"}
			if ip4, ip6 := srv.TailscaleIPs(); ip4.IsValid() {
				ev["ip"] = ip4.String()
			} else if ip6.IsValid() {
				ev["ip"] = ip6.String()
			}
			if st, err := lc.StatusWithoutPeers(ctx); err == nil && st.Self != nil {
				ev["dnsName"] = strings.TrimSuffix(st.Self.DNSName, ".")
			}
			emit(ev)
		case ipn.NeedsLogin:
			// NeedsLogin is also the brief initial state of a node that is about to log in
			// with its saved state or auth key: only report "login" once a URL was issued.
			if !loginPending {
				emit(map[string]any{"event": "state", "state": "starting"})
			}
		case ipn.NeedsMachineAuth:
			emit(map[string]any{"event": "state", "state": "approval"})
		case ipn.Starting:
			emit(map[string]any{"event": "state", "state": "connecting"})
		case ipn.Stopped:
			emit(map[string]any{"event": "state", "state": "starting"})
		}
	}
}

func readCommands(ctx context.Context, stop context.CancelFunc, lc *local.Client, policy *Policy) {
	defer stop() // stdin closed: the app is gone
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var cmd struct {
			Cmd   string   `json:"cmd"`
			Hosts []string `json:"hosts"`
		}
		if json.Unmarshal(sc.Bytes(), &cmd) != nil {
			continue
		}
		switch cmd.Cmd {
		case "allow":
			policy.SetAllow(cmd.Hosts)
		case "logout":
			lctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			if err := lc.Logout(lctx); err != nil {
				emit(map[string]any{"event": "error", "error": "logout: " + err.Error()})
			}
			cancel()
			return
		case "quit":
			return
		}
	}
}
