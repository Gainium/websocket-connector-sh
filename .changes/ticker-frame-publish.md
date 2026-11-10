---
bump: patch
section: Fixed
---
- Price stream: tickers of a multi-symbol frame were published one per timer tick, so the last symbols of a large frame went out noticeably later than the first and consecutive frames interleaved. A frame is now published in one pass, yielding to the event loop every 200 tickers, and frames of the same exchange are published in arrival order.
