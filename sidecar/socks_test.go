package main

import (
	"context"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"
)

type harness struct {
	addr   string
	policy *Policy
	dialed chan string
	ready  *bool
}

// newHarness starts a SOCKS5 server whose "tailnet" is an in-memory echo server.
func newHarness(t *testing.T) *harness {
	t.Helper()
	ready := true
	h := &harness{dialed: make(chan string, 8), ready: &ready}
	h.policy = &Policy{resolve: func(_ context.Context, name string) (netip.Addr, bool) {
		if name == "mypc" || name == "mypc.tail1234.ts.net" {
			return netip.MustParseAddr("100.101.102.103"), true
		}
		if name == "evil" { // a peer name that resolves outside the tailnet
			return netip.MustParseAddr("192.168.1.5"), true
		}
		return netip.Addr{}, false
	}}
	srv := &socksServer{
		policy: h.policy,
		dial: func(_ context.Context, _, addr string) (net.Conn, error) {
			h.dialed <- addr
			a, b := net.Pipe()
			go func() { io.Copy(b, b); b.Close() }() // echo
			return a, nil
		},
		ready:   func() bool { return *h.ready },
		timeout: 2 * time.Second,
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.serve(ctx, ln)
	h.addr = ln.Addr().String()
	return h
}

// request performs a SOCKS5 handshake and returns the reply code and the open connection.
func (h *harness) request(t *testing.T, cmd byte, atyp byte, dest []byte, port uint16) (byte, net.Conn) {
	t.Helper()
	c, err := net.Dial("tcp", h.addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(3 * time.Second))
	c.Write([]byte{5, 1, 0})
	var m [2]byte
	if _, err := io.ReadFull(c, m[:]); err != nil || m != [2]byte{5, 0} {
		t.Fatalf("method selection: %v %v", m, err)
	}
	req := append([]byte{5, cmd, 0, atyp}, dest...)
	c.Write(append(req, byte(port>>8), byte(port)))
	var rep [10]byte
	if _, err := io.ReadFull(c, rep[:]); err != nil {
		t.Fatal(err)
	}
	return rep[1], c
}

func domain(name string) []byte { return append([]byte{byte(len(name))}, name...) }

func TestAllowedIPEchoes(t *testing.T) {
	h := newHarness(t)
	h.policy.SetAllow([]string{"100.101.102.103:18080"})
	code, c := h.request(t, 1, 1, []byte{100, 101, 102, 103}, 18080)
	if code != 0 {
		t.Fatalf("reply %d", code)
	}
	c.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("echo: %q %v", buf, err)
	}
	if got := <-h.dialed; got != "100.101.102.103:18080" {
		t.Fatalf("dialed %s", got)
	}
}

func TestAllowedNameResolvedByTailnetOnly(t *testing.T) {
	h := newHarness(t)
	h.policy.SetAllow([]string{"MyPC.tail1234.ts.net.:443"})
	code, _ := h.request(t, 1, 3, domain("mypc.tail1234.ts.net"), 443)
	if code != 0 {
		t.Fatalf("reply %d", code)
	}
	if got := <-h.dialed; got != "100.101.102.103:443" {
		t.Fatalf("dialed %s", got)
	}
}

func TestDenied(t *testing.T) {
	h := newHarness(t)
	h.policy.SetAllow([]string{"100.101.102.103:18080", "192.168.1.5:80", "8.8.8.8:53", "evil:80", "ghost:80"})
	cases := []struct {
		name string
		cmd  byte
		atyp byte
		dest []byte
		port uint16
		want byte
	}{
		{"empty-port-not-listed", 1, 1, []byte{100, 101, 102, 103}, 22, repNotAllowed},
		{"allowed-but-not-tailscale-ip", 1, 1, []byte{192, 168, 1, 5}, 80, repNotAllowed},
		{"allowed-but-public-ip", 1, 1, []byte{8, 8, 8, 8}, 53, repNotAllowed},
		{"name-resolving-outside-tailnet", 1, 3, domain("evil"), 80, repNotAllowed},
		{"unknown-name", 1, 3, domain("ghost"), 80, repHostUnreach},
		{"not-listed-name", 1, 3, domain("example.com"), 443, repNotAllowed},
		{"bind", 2, 1, []byte{100, 101, 102, 103}, 18080, repCmdUnsupp},
		{"udp-associate", 3, 1, []byte{100, 101, 102, 103}, 18080, repCmdUnsupp},
	}
	for _, tc := range cases {
		code, _ := h.request(t, tc.cmd, tc.atyp, tc.dest, tc.port)
		if code != tc.want {
			t.Errorf("%s: reply %d, want %d", tc.name, code, tc.want)
		}
	}
	if len(h.dialed) != 0 {
		t.Fatalf("a denied request was dialed: %s", <-h.dialed)
	}
}

func TestDenyAllByDefaultAndWhenNotReady(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.request(t, 1, 1, []byte{100, 101, 102, 103}, 18080); code != repNotAllowed {
		t.Fatalf("empty allow list: reply %d", code)
	}
	h.policy.SetAllow([]string{"100.101.102.103:18080"})
	*h.ready = false
	if code, _ := h.request(t, 1, 1, []byte{100, 101, 102, 103}, 18080); code != repNetUnreach {
		t.Fatalf("not connected: reply %d", code)
	}
	h.policy.SetAllow(nil) // session closed: nothing reachable any more
	*h.ready = true
	if code, _ := h.request(t, 1, 1, []byte{100, 101, 102, 103}, 18080); code != repNotAllowed {
		t.Fatalf("after clearing: reply %d", code)
	}
}

func TestAuthRequiredMethodRefused(t *testing.T) {
	h := newHarness(t)
	c, err := net.Dial("tcp", h.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte{5, 1, 2}) // only username/password offered
	var m [2]byte
	if _, err := io.ReadFull(c, m[:]); err != nil || m != [2]byte{5, 0xff} {
		t.Fatalf("got %v %v", m, err)
	}
}
