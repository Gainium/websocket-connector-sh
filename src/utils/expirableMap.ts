export default class ExpirableMap<K, V> extends Map<K, V> {
  private timer: NodeJS.Timeout | null = null
  constructor(
    private expiresAfter: number,
    private updateTimer = false,
    private all = false,
  ) {
    super()
  }
  override set(key: K, value: V): this {
    if (this.updateTimer) {
      if (this.timer) {
        clearTimeout(this.timer)
      }
      this.timer = setTimeout(() => {
        if (this.all) {
          this.clear()
        } else {
          this.delete(key)
        }
      }, this.expiresAfter)
      // An eviction timer must never be a reason to keep the process running —
      // with a multi-hour TTL it otherwise holds the event loop open long after
      // there is nothing left to do (and hangs `npm test`).
      this.timer.unref?.()
    }
    setTimeout(() => {
      this.delete(key)
    }, this.expiresAfter).unref?.()
    return super.set(key, value)
  }
}
