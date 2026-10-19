package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A minimal SOCKS5 server: no authentication, CONNECT only. It only listens on
// loopback; what it may reach is decided by Policy.
type socksServer struct {
	policy  *Policy
	dial    func(ctx context.Context, network, addr string) (net.Conn, error)
	ready   func() bool                // false until the node is connected: never dial before
	onDeny  func(target, reason string) // optional, for diagnostics
	timeout time.Duration
}

func (s *socksServer) serve(ctx context.Context, ln net.Listener) {
	go func() { <-ctx.Done(); ln.Close() }()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go s.handle(ctx, c)
	}
}

func reply(c net.Conn, code byte) {
	c.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

func (s *socksServer) handle(ctx context.Context, c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second)) // handshake only

	var head [4]byte
	if _, err := io.ReadFull(c, head[:2]); err != nil || head[0] != 5 {
		return
	}
	methods := make([]byte, head[1])
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	noAuth := false
	for _, m := range methods {
		noAuth = noAuth || m == 0
	}
	if !noAuth {
		c.Write([]byte{5, 0xff})
		return
	}
	c.Write([]byte{5, 0})

	if _, err := io.ReadFull(c, head[:]); err != nil || head[0] != 5 {
		return
	}
	if head[1] != 1 { // CONNECT only: no BIND, no UDP ASSOCIATE
		reply(c, repCmdUnsupp)
		return
	}
	var host string
	switch head[3] {
	case 1, 4:
		ip := make([]byte, 4*int(head[3]))
		if _, err := io.ReadFull(c, ip); err != nil {
			return
		}
		a, _ := netip.AddrFromSlice(ip)
		host = a.String()
	case 3:
		var n [1]byte
		if _, err := io.ReadFull(c, n[:]); err != nil {
			return
		}
		name := make([]byte, n[0])
		if _, err := io.ReadFull(c, name); err != nil {
			return
		}
		host = string(name)
	default:
		reply(c, repAtypUnsupp)
		return
	}
	var pb [2]byte
	if _, err := io.ReadFull(c, pb[:]); err != nil {
		return
	}
	port := int(pb[0])<<8 | int(pb[1])
	target := net.JoinHostPort(host, strconv.Itoa(port))

	deny := func(code byte, reason string) {
		if s.onDeny != nil {
			s.onDeny(target, reason)
		}
		reply(c, code)
	}
	if !s.ready() {
		deny(repNetUnreach, "Tailscale is not connected")
		return
	}
	dctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	ap, serr := s.policy.Check(dctx, host, port)
	if serr != nil {
		deny(serr.code, serr.msg)
		return
	}
	up, err := s.dial(dctx, "tcp", ap.String())
	if err != nil {
		code := byte(repHostUnreach)
		switch {
		case strings.Contains(err.Error(), "refused"):
			code = repRefused
		case errors.Is(err, context.DeadlineExceeded):
			code = repTTLExpired
		}
		deny(code, err.Error())
		return
	}
	defer up.Close()
	reply(c, 0)
	c.SetDeadline(time.Time{})

	var wg sync.WaitGroup
	wg.Add(2)
	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
	}
	go pipe(up, c)
	go pipe(c, up)
	wg.Wait()
}
