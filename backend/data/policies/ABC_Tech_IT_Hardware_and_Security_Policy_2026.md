# ABC Technologies IT Hardware & Security Policy (2026)

## 1. Hardware Allocation & Standards
All engineering and staff personnel are provisioned corporate hardware based on their job tier:
- **Engineering Staff**: Apple MacBook Pro 16-inch (M3/M4 Max with 36GB+ Unified Memory) or Dell XPS 15 (i9 / 32GB RAM / 1TB SSD).
- **Operations & Management**: Apple MacBook Air 15-inch M3 or Dell Latitude 7440.
- **External Peripherals**: Employees may request up to two 4K external monitors (Dell UltraSharp 32" U3223QE), ergonomic keyboard, mouse, and a Thunderbolt 4 docking hub.

## 2. Laptop Replacement & Refresh Cycles
- Standard hardware refresh cycle is 36 months (3 years) from original provisioning date.
- Employees reaching 36 months of tenure with their current assigned machine are automatically eligible for hardware upgrades.
- Requisitions before 36 months require technical justification (e.g., severe hardware degradation, thermal throttling, swollen battery, or broken chassis).

## 3. Hardware Upgrade Requisition Procedure
Hardware upgrades may be requested directly via OmniDesk AI copilot:
- Category must be specified as `IT_HARDWARE`.
- Urgency levels are defined as: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.
- Requests marked `CRITICAL` or `HIGH` are immediately escalated to the IT Admin on duty.
- Requisitions are staged through cryptographic Human-in-the-Loop approval cards before procurement or dispatch.

## 4. VPN and Remote Access Security
- When working outside corporate office networks, employees must connect via the corporate VPN (Tailscale Enterprise / GlobalProtect).
- Multi-Factor Authentication (MFA) is strictly required on all corporate VPN gateways.
- Full disk encryption (FileVault on macOS, BitLocker on Windows) must remain permanently enabled.
- Connecting to corporate staging or production infrastructure from unsecured public Wi-Fi without VPN is a security violation.
