# Enhanced Per-Device Access Control System

## Problem Solved
Previously, when multiple devices connected to the same router, if one device watched videos and earned data bundles, ALL devices on that router would gain internet access. This was a significant security and fairness issue.

## Solution Overview
The Enhanced Per-Device Access Control System ensures that **each device must earn its own access** by watching videos. No device can "piggyback" on another device's video watching.

## Key Features

### 1. 🔒 MAC Address Binding
- Each device's access is bound to its unique MAC address
- Prevents device spoofing and ensures true device isolation
- Automatically resolves MAC addresses from ARP cache and DHCP logs

### 2. 🏠 Router-Level Device Blocking (Optional)
- When enabled, only ONE device per router can have active internet access
- Other devices are blocked until they earn their own access
- Prevents bandwidth sharing and ensures fair usage

### 3. ⏰ Token Expiration & Revalidation
- Access tokens expire after configurable time (default: 24 hours)
- Devices must revalidate periodically (default: every 6 hours)
- Grace period for revalidation before hard blocking (default: 30 minutes)

### 4. 📱 Device Session Isolation
- Each device has its own session token and access rights
- Sessions don't transfer between devices, even with same user account
- Real-time validation on every internet request

### 5. 👨‍💼 Admin Monitoring & Control
- Live dashboard showing all device access statuses
- Ability to revoke device access manually
- Router blocking status and device isolation statistics

## Configuration Options

Set these environment variables to enable different features:

```bash
# Enable strict device isolation
STRICT_DEVICE_ISOLATION=true

# Access token lifetime
ACCESS_TOKEN_TTL_HOURS=24

# Revalidation frequency
REVALIDATION_INTERVAL_HOURS=6
REVALIDATION_GRACE_MINUTES=30

# Enable MAC address binding
MAC_BINDING_ENABLED=true

# Router-level blocking (only one device per router)
ROUTER_DEVICE_BLOCKING=true
```

## How It Works

### Before Enhancement (Problem):
```
Router: 10.5.48.94
├── Device A (Phone) → Watches 5 videos → Earns 100MB
├── Device B (Laptop) → Does nothing → Gets 100MB access! ❌
└── Device C (Tablet) → Does nothing → Gets 100MB access! ❌
```

### After Enhancement (Solution):
```
Router: 10.5.48.94
├── Device A (Phone) → Watches 5 videos → Earns 100MB ✅
├── Device B (Laptop) → Must watch videos → Blocked until earns access 🔒
└── Device C (Tablet) → Must watch videos → Blocked until earns access 🔒
```

## Implementation Details

### Device Fingerprinting
Enhanced fingerprinting combines:
- User-Agent string
- MAC address (from ARP/DHCP)
- HTTP headers (Accept, Accept-Language, etc.)
- IP address
- Router ID

### Access Token Structure
```javascript
{
  accessToken: "32-char-hex-token",
  deviceId: "device-fingerprint", 
  macAddress: "aabbccddeeff",
  identifier: "user@example.com",
  routerId: "10.5.48.94",
  videosWatched: 5,
  bundlesMB: 100,
  earnedAt: "2025-08-28T12:00:00Z",
  expiresAt: "2025-08-29T12:00:00Z",
  nextRevalidation: "2025-08-28T18:00:00Z",
  isValid: true
}
```

### Proxy Integration
The proxy server validates device access on every HTTP/HTTPS request:

1. **Extract device fingerprint** from request headers
2. **Validate access token** for that specific device
3. **Check MAC address binding** (if enabled)
4. **Verify token expiration** and revalidation status
5. **Apply router blocking** (if enabled)
6. **Allow or block** the request accordingly

## Admin Endpoints

### Get Device Access Status
```http
GET /api/admin/device-access
Headers:
  x-user-identifier: admin@example.com

Response:
{
  "ok": true,
  "deviceAccessControl": {
    "totalDevices": 5,
    "activeDevices": 3,
    "expiredDevices": 1,
    "pendingRevalidation": 1,
    "devices": [...],
    "routerBlocking": {...},
    "configuration": {...}
  }
}
```

### Revoke Device Access
```http
POST /api/admin/device-access/revoke
Headers:
  x-user-identifier: admin@example.com
Body:
{
  "deviceId": "ef41b716ab...",
  "reason": "Security violation"
}
```

## Testing

Run the test script to verify functionality:
```bash
node test-fingerprint.js
```

This will test:
- Device fingerprinting
- Access token generation
- Device validation
- Router blocking (if enabled)
- Status reporting

## Security Benefits

1. **Prevents Freeloading**: Each device must earn its own access
2. **Fair Resource Usage**: No device can consume bandwidth without earning it
3. **Device Accountability**: Each device's usage is tracked independently
4. **Router Isolation**: Optional blocking prevents device cross-contamination
5. **Temporal Security**: Access tokens expire, requiring re-earning
6. **MAC Binding**: Prevents device impersonation

## Migration Guide

### Existing Users
- Current users will need to revalidate their devices
- Each device will need to watch videos independently
- Data bundles earned before enhancement remain valid

### New Deployments
- Enable all features from the start for maximum security
- Consider router blocking for high-security environments
- Adjust token TTL based on your usage patterns

## Troubleshooting

### MAC Address Resolution Issues
- Ensure ARP cache is accessible
- Check DHCP server logs for IP→MAC mapping
- Consider implementing router API integration

### Router Blocking Too Restrictive
- Disable `ROUTER_DEVICE_BLOCKING` if needed
- Increase `REVALIDATION_INTERVAL_HOURS` for less frequent checks
- Adjust `REVALIDATION_GRACE_MINUTES` for more flexibility

### Performance Considerations
- Device validation adds minimal overhead (~1-2ms per request)
- MAC resolution is cached for 5 minutes
- Token storage is in-memory (consider Redis for scaling)

## Future Enhancements

1. **DHCP Integration**: Direct DHCP server monitoring
2. **Router API Integration**: Real-time device detection
3. **Geofencing**: Location-based access control
4. **Device Profiles**: Different rules for different device types
5. **Usage Analytics**: Per-device usage patterns and optimization
