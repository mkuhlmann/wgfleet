# Server

Manages WireGuard servers and their peers: identity/keys, address assignment, firewall policy, and traffic accounting.

## Language

**Peer Address Resolution**:
Deciding the wgAddress a peer gets - either validating a caller-requested address against the server's CIDR range and its other peers, or auto-allocating the next free one starting from the server's reserved-IPs offset.
_Avoid_: IP allocation (too generic - this is always scoped to one server's peers)
