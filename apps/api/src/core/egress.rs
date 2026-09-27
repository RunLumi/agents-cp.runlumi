//! Shared outbound-egress primitives.
//!
//! Four surfaces let a caller influence a host the Worker will later connect
//! to: provider endpoints, MCP server endpoints, webhook delivery endpoints,
//! and plugin `network_destinations` declarations. They deliberately have
//! *different policies* — an operator-owned exact-host allowlist, a
//! range-and-name check with no allowlist, and a declaration vocabulary that
//! also accepts `*.suffix` patterns — and those policies stay in their own
//! modules.
//!
//! What must NOT differ between them is the *notion of a blocked destination*.
//! When each call site carried its own range table they drifted: the webhook
//! transport resolved `::ffff:127.0.0.1` to an embedded loopback and refused
//! it, while the provider guard did not, so the same address was a hard block
//! on one surface and an ordinary hostname on another. This module is the one
//! table.
//!
//! It is deliberately mode-free: no Cloudflare binding, no transport, no
//! configuration, no allowlist. A caller supplies a host or an address and gets
//! a decision. Policy composition stays with the caller.
//!
//! # Why the input must be a SERIALIZED host
//!
//! Every helper here takes the host as it will appear on the wire, not as the
//! caller spelled it. WHATWG URL parsing — which is what the Workers `fetch`
//! API uses to turn a URL string into a connection — normalizes the historical
//! IPv4 spellings: `127.1`, `0177.0.0.1`, `0x7f.0.0.1`, `2130706433` and
//! `017700000001` all become `127.0.0.1`, and `127.0.0.1.` loses its trailing
//! dot. It also percent-decodes (`ex%41mple.com` becomes `example.com`),
//! lowercases, punycodes IDN hosts, and returns an IPv6 literal in bracket
//! form (`[::1]`).
//!
//! Running these checks against the raw spelling is how a loopback hides from
//! a range check while the transport still connects to it. Callers must
//! therefore pass `Url::host_str()`, not a hand-rolled substring.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Interpret a bare host as an IP literal, or `None` if it is a name.
///
/// A URL parser returns an IPv6 literal in bracket form (`[::1]`), which is not
/// an address. Callers strip the brackets as part of normalizing the host, and
/// this stays a strict whole-string read so there is exactly one place that
/// knows about brackets. A name that merely ends in digits
/// (`127.0.0.1.example.com`) is a name, not an address.
pub fn parse_ip_literal(host: &str) -> Option<IpAddr> {
    host.parse::<IpAddr>().ok()
}

/// True for a destination this platform refuses to connect to on principle.
///
/// Covers loopback, unspecified, link-local, private, CGNAT, multicast,
/// documentation, benchmarking, protocol-assignment, reserved, and
/// cloud-metadata ranges, in both address families. `169.254.169.254` and
/// `::ffff:169.254.169.254` are both refused: the second one carries the first
/// in its low 32 bits.
pub fn is_blocked_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => is_blocked_v4(*value),
        IpAddr::V6(value) => is_blocked_v6(*value),
    }
}

fn is_blocked_v4(value: Ipv4Addr) -> bool {
    let [a, b, ..] = value.octets();
    value.is_unspecified()
        || value.is_loopback()
        || value.is_private()
        || value.is_link_local()
        || value.is_multicast()
        || value.is_broadcast()
        || value.is_documentation()
        || (a == 0) // "this network"
        || (a == 100 && (64..=127).contains(&b)) // carrier-grade NAT
        || (a == 192 && b == 0 && value.octets()[2] == 0) // IETF protocol assignments
        || (a == 192 && b == 88 && value.octets()[2] == 99) // 6to4 relay anycast
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || (a == 198 && b == 51 && value.octets()[2] == 100) // TEST-NET-2
        || (a == 203 && b == 0 && value.octets()[2] == 113) // TEST-NET-3
        || a >= 240 // reserved, including 255.255.255.255
}

fn is_blocked_v6(value: Ipv6Addr) -> bool {
    if value.is_loopback() || value.is_unspecified() || value.is_multicast() {
        return true;
    }
    let segments = value.segments();
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (segments[0] & 0xfe00) == 0xfc00 || (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): re-check the
    // embedded IPv4 address so a mapped loopback cannot bypass the IPv4 rules.
    if let Some(embedded) = embedded_v4(value) {
        return is_blocked_v4(embedded);
    }
    // Documentation (2001:db8::/32), 6to4 (2002::/16), and Teredo (2001::/32)
    // carry an embedded IPv4 destination or are not globally routable.
    if (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[0] == 0x2002
        || segments[0] == 0x2001
    {
        return true;
    }
    // RFC 6052 well-known prefix (64:ff9b::/96) embeds an IPv4 destination in
    // its low 32 bits. The Workers runtime has no NAT64 translator, so this is
    // precautionary rather than a known bypass; it is refused because a
    // deployment must not depend on the absence of one, and no legitimate
    // control-plane endpoint lives in this prefix.
    segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0]
}

fn embedded_v4(value: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = value.segments();
    if segments[..5] == [0, 0, 0, 0, 0] && matches!(segments[5], 0 | 0xffff) {
        let octets = value.octets();
        return Some(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    None
}

/// True for a host that is a syntactically valid DNS name.
///
/// Deliberately stricter than the URL parser: LDH labels only, no root label,
/// no empty label, no leading or trailing hyphen. A name that fails this is
/// refused rather than resolved, because a resolver cannot be trusted to map an
/// odd spelling to the host the caller meant.
pub fn is_dns_name(host: &str) -> bool {
    !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// Split-horizon and special-use names that are refused before any lookup.
///
/// These resolve to loopback, to nothing, or to something only the platform
/// operator's network can see. A resolver cannot be trusted to map them to a
/// public address, so they are refused on the name alone. `metadata.google.internal`
/// and any other `.internal` name falls out of the suffix list without needing
/// its own entry.
pub fn is_reserved_host_name(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
        || host.ends_with(".in-addr.arpa")
        || host.ends_with(".onion")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bracket_form_host_is_not_an_address_and_stripping_is_the_callers_job() {
        // A URL parser returns IPv6 hosts bracketed. A range check fed the
        // brackets is a range check that never fires, and a caller that forgot
        // to strip them would read every IPv6 literal as a malformed name.
        assert_eq!(parse_ip_literal("[::1]"), None);
        assert_eq!(parse_ip_literal("[2606:4700::1111]"), None);
        assert_eq!(parse_ip_literal("::1"), Some("::1".parse().unwrap()));
        assert_eq!(
            parse_ip_literal("::ffff:127.0.0.1"),
            Some("::ffff:127.0.0.1".parse().unwrap())
        );
        assert_eq!(
            parse_ip_literal("2606:4700::1111"),
            Some("2606:4700::1111".parse().unwrap())
        );
        assert_eq!(
            parse_ip_literal("127.0.0.1"),
            Some("127.0.0.1".parse().unwrap())
        );
    }

    #[test]
    fn a_name_is_never_mistaken_for_a_literal() {
        // Whole-string read only: a name that ends in digits, brackets an IP,
        // or carries a port is a name, and the range check has no basis to
        // call it private.
        for host in [
            "127.0.0.1.example.com",
            "[127.0.0.1].example.com",
            "127.0.0.1:8443",
            "[::1",
            "::1]",
            "0.0.1",
            "example.com",
        ] {
            assert_eq!(parse_ip_literal(host), None, "{host} parsed as an address");
        }
    }

    #[test]
    fn every_blocked_range_is_refused_in_both_families() {
        for literal in [
            "0.0.0.0",
            "0.1.2.3", // "this network"
            "10.0.0.5",
            "100.64.0.1", // carrier-grade NAT
            "100.127.255.254",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254", // cloud metadata (AWS/Azure/GCP)
            "172.16.4.4",
            "192.0.0.1",   // IETF protocol assignments
            "192.0.2.5",   // TEST-NET-1
            "192.88.99.1", // 6to4 relay anycast
            "192.168.1.1",
            "198.18.0.1", // benchmarking
            "198.19.255.254",
            "198.51.100.5", // TEST-NET-2
            "203.0.113.5",  // TEST-NET-3
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(is_blocked_address(&address), "allowed {literal}");
        }
        for literal in [
            "::",
            "::1",
            "::ffff:0:0",
            "::ffff:127.0.0.1",       // mapped loopback
            "::ffff:169.254.169.254", // mapped cloud metadata
            "::127.0.0.1",            // IPv4-compatible loopback
            "64:ff9b::7f00:1",        // NAT64 embedding 127.0.0.1
            "2001:db8::1",            // documentation
            "2002:7f00:1::",          // 6to4
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "ff02::1",
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(is_blocked_address(&address), "allowed {literal}");
        }
    }

    #[test]
    fn globally_routable_addresses_stay_usable() {
        // A guard that refused these would make every real deployment fail, and
        // a table that over-blocks is a table people learn to work around.
        for literal in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "100.63.255.255", // just below CGNAT
            "100.128.0.1",    // just above CGNAT
            "172.15.255.255", // just below RFC1918
            "172.32.0.1",     // just above RFC1918
            "192.167.255.255",
            "192.169.0.1",
            "198.17.255.255",
            "198.20.0.1",
            "2606:4700::1111",
            "2a00:1450:4001:80f::200e",
        ] {
            let address: IpAddr = literal.parse().unwrap();
            assert!(!is_blocked_address(&address), "blocked {literal}");
        }
    }

    #[test]
    fn dns_name_syntax_is_ldh_labels_only() {
        for name in [
            "example.com",
            "a.b.c.d.example.com",
            "xn--e1afmkfd.xn--p1ai",
            "api-1.example.com",
            "a",
            // A name that merely LOOKS like an address is a name, and this check
            // accepts it. It is `parse_ip_literal`, not the syntax check, that
            // must not read it as an address.
            "127.0.0.1.example.com",
        ] {
            assert!(is_dns_name(name), "refused {name}");
        }
        for name in [
            "",
            ".",
            ".example.com",
            "example.com.",
            "example..com",
            "-example.com",
            "example-.com",
            "exa_mple.com",
            "exa mple.com",
            "exämple.com", // not punycoded: callers pass the serialized host
            "x-y-z-",
        ] {
            assert!(!is_dns_name(name), "accepted {name}");
        }
    }

    #[test]
    fn split_horizon_and_special_use_names_are_refused() {
        for name in [
            "localhost",
            "api.localhost",
            "printer.local",
            "db.internal",
            "metadata.google.internal",
            "x.internal",
            "host.home.arpa",
            "1.0.0.127.in-addr.arpa",
            "duskgytldkxiuqc6.onion",
        ] {
            assert!(is_reserved_host_name(name), "accepted {name}");
        }
        for name in [
            "example.com",
            "internal.example.com",
            "notlocalhost.example.com",
            "localhost.example.com",
            "myinternal",
            "x.onion.example.com",
        ] {
            assert!(!is_reserved_host_name(name), "refused {name}");
        }
    }
}
