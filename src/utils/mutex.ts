export class IdMutex {
  private lockMap: Map<string, { queue: Array<() => void>; locked: boolean }> =
    new Map()

  lock(id: string): Promise<void> {
    return new Promise((resolve) => {
      if (this.lockMap.get(id)?.locked) {
        this.lockMap.get(id)?.queue.push(resolve)
      } else {
        if (!this.lockMap.get(id)) {
          this.lockMap.set(id, { queue: [], locked: true })
        }
        const get = this.lockMap.get(id)
        if (get) {
          get.locked = true
        }
        resolve()
      }
    })
  }

  release(id: string) {
    const resolve = this.lockMap.get(id)?.queue.shift()
    if (resolve) {
      resolve()
    } else {
      this.lockMap.delete(id)
    }
  }

  clear() {
    this.lockMap = new Map()
  }
}

export function IdMute(mutex: IdMutex, getId: (...args: any[]) => string) {
  return (
    _target: unknown,
    _propertyKey: PropertyKey,
    descriptor: PropertyDescriptor,
  ) => {
    const fn = descriptor.value
    descriptor.value = function (...args: unknown[]) {
      const id = getId(...args)
      return mutex
        .lock(id)
        .then(() => fn.apply(this, args))
        .then((res) => {
          mutex.release(id)
          return res
        })
        .catch((e) => {
          mutex.release(id)
          throw e
        })
    }
  }
}
