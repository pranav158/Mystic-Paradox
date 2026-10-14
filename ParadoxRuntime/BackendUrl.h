/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

// [2026-10-13 realms S1] Pure parser for the backend address the launcher hands to the game process in the
// environment variable MYSTICPARADOX_BACKEND_URL. Header-only and free of Windows/engine types so the edge cases can
// be exercised by a throwaway console build; dllmain.cpp owns the environment read, the one-time resolution and the log.
//
// Accepted form, exactly:   scheme://host[:port]
//   scheme  http or https (case-insensitive)
//   host    DNS name (labels of letters, digits and inner '-', at most 63 each, at most 253 in all, last label not
//           all digits, no trailing dot), dotted-quad IPv4 (no leading zeros), or a bracketed IPv6 literal
//   port    1-65535, no leading zero; absent means 80 (http) / 443 (https)
// Rejected: any space, control or non-ASCII character, user information ('@'), a path, query or fragment (even a
// lone trailing '/'), an unbracketed IPv6 literal, a zone id, an empty host or port, anything over 300 characters.

#include <cstddef>
#include <cstdint>
#include <string>

constexpr size_t kMpBackendUrlMaxChars = 300;

struct MpBackendUrl {
    bool Secure = true;      // https / wss
    std::string Host;        // lower-case DNS name or IPv4 address, or an IPv6 literal with its brackets
    uint16_t Port = 443;     // the explicit port, else the scheme default
};

namespace MpBackendUrlDetail {

inline bool IsDigit(char C) { return C >= '0' && C <= '9'; }
inline bool IsHex(char C) { return IsDigit(C) || (C >= 'a' && C <= 'f') || (C >= 'A' && C <= 'F'); }
inline bool IsAlnum(char C) { return IsDigit(C) || (C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z'); }

inline std::string Lower(std::string S) {
    for (char& C : S) {
        if (C >= 'A' && C <= 'Z') C = static_cast<char>(C + ('a' - 'A'));
    }
    return S;
}

// Dotted quad: exactly four decimal parts of 1-3 digits, each at most 255, no leading zeros.
inline bool IsIPv4(const std::string& S) {
    int Parts = 0;
    size_t I = 0;
    while (true) {
        const size_t Start = I;
        int Value = 0;
        while (I < S.size() && IsDigit(S[I])) {
            if (I - Start >= 3) return false;
            Value = Value * 10 + (S[I] - '0');
            ++I;
        }
        const size_t Length = I - Start;
        if (Length == 0) return false;
        if (Length > 1 && S[Start] == '0') return false;
        if (Value > 255) return false;
        ++Parts;
        if (I == S.size()) break;
        if (S[I] != '.') return false;
        ++I;
    }
    return Parts == 4;
}

// One side of an IPv6 literal split at "::": colon-separated groups of 1-4 hex digits; only the very last token of
// the whole address (LastSide) may be a dotted quad, which counts as two groups. An empty side has zero groups.
inline bool CountIPv6Groups(const std::string& Side, bool LastSide, int& Groups) {
    Groups = 0;
    if (Side.empty()) return true;
    size_t Start = 0;
    while (true) {
        const size_t Colon = Side.find(':', Start);
        const bool Last = (Colon == std::string::npos);
        const std::string Token = Last ? Side.substr(Start) : Side.substr(Start, Colon - Start);
        if (Token.empty()) return false;
        if (Token.find('.') != std::string::npos) {
            if (!(Last && LastSide) || !IsIPv4(Token)) return false;
            Groups += 2;
        }
        else {
            if (Token.size() > 4) return false;
            Groups += 1;
        }
        if (Last) break;
        Start = Colon + 1;
    }
    return true;
}

// RFC 4291 text form without brackets or zone id: eight groups, or at most seven around one "::".
inline bool IsIPv6(const std::string& S) {
    if (S.size() < 2 || S.size() > 45) return false;
    for (char C : S) {
        if (!IsHex(C) && C != ':' && C != '.') return false;
    }
    const size_t Double = S.find("::");
    int LeftGroups = 0;
    int RightGroups = 0;
    if (Double == std::string::npos) {
        if (!CountIPv6Groups(S, true, LeftGroups)) return false;
        return LeftGroups == 8;
    }
    if (S.find("::", Double + 1) != std::string::npos) return false;   // a second "::", or ":::"
    if (!CountIPv6Groups(S.substr(0, Double), false, LeftGroups)) return false;
    if (!CountIPv6Groups(S.substr(Double + 2), true, RightGroups)) return false;
    return LeftGroups + RightGroups <= 7;
}

inline bool IsDnsName(const std::string& S) {
    if (S.empty() || S.size() > 253) return false;
    size_t LabelLength = 0;
    bool LabelAllDigits = true;
    char Previous = '.';
    for (char C : S) {
        if (C == '.') {
            if (LabelLength == 0 || Previous == '-') return false;   // leading dot, "..", or a label ending in '-'
            LabelLength = 0;
            LabelAllDigits = true;
            Previous = C;
            continue;
        }
        if (!IsAlnum(C) && C != '-') return false;
        if (LabelLength == 0 && C == '-') return false;
        if (++LabelLength > 63) return false;
        if (!IsDigit(C)) LabelAllDigits = false;
        Previous = C;
    }
    if (LabelLength == 0 || Previous == '-') return false;           // trailing dot, or a label ending in '-'
    return !LabelAllDigits;                                           // the last label is never all digits
}

}  // namespace MpBackendUrlDetail

// Parses Text into Out. On failure returns false with Reason set to a static, log-safe description that never echoes
// the input (an invalid value may still have carried user information).
inline bool MpParseBackendUrl(const std::string& Text, MpBackendUrl& Out, const char*& Reason) {
    using namespace MpBackendUrlDetail;
    Reason = "";
    if (Text.empty()) { Reason = "empty value"; return false; }
    if (Text.size() > kMpBackendUrlMaxChars) { Reason = "value too long"; return false; }
    for (char C : Text) {
        const unsigned char U = static_cast<unsigned char>(C);
        if (U <= 0x20 || U >= 0x7F) { Reason = "contains a space, control or non-ASCII character"; return false; }
    }

    const size_t SchemeEnd = Text.find("://");
    if (SchemeEnd == std::string::npos) { Reason = "missing scheme://"; return false; }
    const std::string Scheme = Lower(Text.substr(0, SchemeEnd));
    bool Secure = true;
    if (Scheme == "https") Secure = true;
    else if (Scheme == "http") Secure = false;
    else { Reason = "scheme must be http or https"; return false; }

    const std::string Authority = Text.substr(SchemeEnd + 3);
    if (Authority.empty()) { Reason = "missing host"; return false; }
    if (Authority.find('@') != std::string::npos) { Reason = "user information is not allowed"; return false; }
    if (Authority.find_first_of("/?#\\") != std::string::npos) {
        Reason = "path, query and fragment are not allowed";
        return false;
    }

    std::string Host;
    std::string PortText;
    bool HasPort = false;
    if (Authority[0] == '[') {
        const size_t Close = Authority.find(']');
        if (Close == std::string::npos) { Reason = "unterminated [IPv6] literal"; return false; }
        const std::string Inner = Authority.substr(1, Close - 1);
        if (!IsIPv6(Inner)) { Reason = "malformed IPv6 address"; return false; }
        Host = "[" + Lower(Inner) + "]";
        const std::string Rest = Authority.substr(Close + 1);
        if (!Rest.empty()) {
            if (Rest[0] != ':') { Reason = "unexpected text after the IPv6 literal"; return false; }
            PortText = Rest.substr(1);
            HasPort = true;
        }
    }
    else {
        const size_t Colon = Authority.find(':');
        if (Colon != std::string::npos && Authority.find(':', Colon + 1) != std::string::npos) {
            Reason = "more than one ':' outside [brackets]";
            return false;
        }
        Host = Authority.substr(0, Colon);
        if (Colon != std::string::npos) {
            PortText = Authority.substr(Colon + 1);
            HasPort = true;
        }
        if (Host.empty()) { Reason = "missing host"; return false; }
        if (Host.find_first_not_of("0123456789.") == std::string::npos) {
            if (!IsIPv4(Host)) { Reason = "malformed IPv4 address"; return false; }
        }
        else if (!IsDnsName(Host)) {
            Reason = "malformed host name";
            return false;
        }
        Host = Lower(Host);
    }

    uint16_t Port = Secure ? 443 : 80;
    if (HasPort) {
        if (PortText.empty() || PortText.size() > 5 || PortText[0] == '0'
            || PortText.find_first_not_of("0123456789") != std::string::npos) {
            Reason = "port must be 1-65535";
            return false;
        }
        unsigned Value = 0;
        for (char C : PortText) Value = Value * 10 + static_cast<unsigned>(C - '0');
        if (Value == 0 || Value > 65535) { Reason = "port must be 1-65535"; return false; }
        Port = static_cast<uint16_t>(Value);
    }

    Out.Secure = Secure;
    Out.Host = Host;
    Out.Port = Port;
    return true;
}

inline uint16_t MpBackendDefaultPort(bool Secure) { return Secure ? 443 : 80; }

// The API base the HTTP redirect prepends "/__origin/<host><path>" to: scheme://host, with the port only when it is
// not the scheme default (so https://host:443 comes out as https://host, the built-in form).
inline std::wstring MpBackendApiBase(const MpBackendUrl& Url) {
    std::wstring Out = Url.Secure ? L"https://" : L"http://";
    Out.append(Url.Host.begin(), Url.Host.end());
    if (Url.Port != MpBackendDefaultPort(Url.Secure)) {
        Out += L":";
        Out += std::to_wstring(static_cast<unsigned>(Url.Port));
    }
    return Out;
}

// The chat WebSocket address the client is given as XMPP ServerAddr: ws/wss matching http/https, the same host, no path
// and NO port. The 1.12 client built its URL as ServerAddr + ":" + ServerPort, so a path or a port in this string
// produces "...:443" after it; the port travels separately (MpBackendUrl::Port, written to ServerPort).
inline std::wstring MpBackendXmppAddress(const MpBackendUrl& Url) {
    std::wstring Out = Url.Secure ? L"wss://" : L"ws://";
    Out.append(Url.Host.begin(), Url.Host.end());
    return Out;
}
