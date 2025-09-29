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
    }
    setTimeout(() => {
      this.delete(key)
    }, this.expiresAfter)
    return super.set(key, value)
  }
}
