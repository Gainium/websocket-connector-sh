---
bump: patch
section: Fixed
---
- Kraken spot candles: after a reconnect, candle subscriptions are re-sent in paced batches instead of one message per earlier request all at once, which Kraken refused for rate; a rate refusal that cannot be matched to a sent batch is now retried after a backoff instead of leaving those symbols without candles
