package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"

	"tailscale.com/net/tsaddr"
)

// Policy decides which destinations the SOCKS5 proxy may reach. It exists because
// tsnet's Dial falls back to the host network for addresses outside the tailnet,
// which would silently leave the tunnel. Rules, all of which must hold:
//   - the host:port is in the allow list pushed by the client (empty = deny all);
//   - the address is a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48);
//   - names are resolved only against the tailnet's peers, never by the system DNS.
type Policy struct {
	mu      sync.RWMutex
	allow   map[string]struct{}
	resolve func(ctx context.Context, name string) (netip.Addr, bool)
}

// socksError carries the SOCKS5 reply code together with a readable reason.
type socksError struct {
	code byte
	msg  string
}

func (e *socksError) Error() string { return e.msg }

// SOCKS5 reply codes (RFC 1928)
const (
	repNotAllowed  = 0x02
	repNetUnreach  = 0x03
	repHostUnreach = 0x04
	repRefused     = 0x05
	repTTLExpired  = 0x06
	repCmdUnsupp   = 0x07
	repAtypUnsupp  = 0x08
)

// normHost lower-cases a name, drops a trailing dot or IPv6 brackets and
// canonicalises IP literals so "100.64.0.1" and "::ffff:100.64.0.1" compare equal.
func normHost(h string) string {
	h = strings.TrimSuffix(strings.ToLower(strings.Trim(h, "[]")), ".")
	if a, err := netip.ParseAddr(h); err == nil {
		return a.Unmap().String()
	}
	return h
}

func allowKey(host string, port int) string {
	return net.JoinHostPort(normHost(host), strconv.Itoa(port))
}

// SetAllow replaces the allow list; entries are "host:port" ("[v6]:port" for IPv6).
func (p *Policy) SetAllow(hosts []string) {
	m := make(map[string]struct{}, len(hosts))
	for _, hp := range hosts {
		h, ps, err := net.SplitHostPort(hp)
		if err != nil {
			continue
		}
		port, err := strconv.Atoi(ps)
		if err != nil || port < 1 || port > 65535 {
			continue
		}
		m[allowKey(h, port)] = struct{}{}
	}
	p.mu.Lock()
	p.allow = m
	p.mu.Unlock()
}

// Check returns the tailnet address to dial for a requested host:port.
func (p *Policy) Check(ctx context.Context, host string, port int) (netip.AddrPort, *socksError) {
	p.mu.RLock()
	_, ok := p.allow[allowKey(host, port)]
	p.mu.RUnlock()
	if !ok {
		return netip.AddrPort{}, &socksError{repNotAllowed, fmt.Sprintf("%s is not in the allow list", allowKey(host, port))}
	}
	var addr netip.Addr
	if a, err := netip.ParseAddr(normHost(host)); err == nil {
		addr = a
	} else {
		a, found := p.resolve(ctx, normHost(host))
		if !found {
			return netip.AddrPort{}, &socksError{repHostUnreach, fmt.Sprintf("%q is not a peer of the tailnet", host)}
		}
		addr = a
	}
	if !tsaddr.IsTailscaleIP(addr) {
		return netip.AddrPort{}, &socksError{repNotAllowed, fmt.Sprintf("%s is not a Tailscale address", addr)}
	}
	return netip.AddrPortFrom(addr, uint16(port)), nil
}
