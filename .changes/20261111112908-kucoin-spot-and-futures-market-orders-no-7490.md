---
bump: patch
section: Fixed
---
- KuCoin spot and futures market orders now report the venue-charged fee on their filled update: the order streams carry no fee, so it is read from the order's REST record (spot) or its fills (futures) with a short bounded wait, and left out when it cannot be read
