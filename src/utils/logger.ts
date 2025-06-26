const log = (type: 'error' | 'info' | 'warn', ...msg: any[]) => {
  const time = new Date()
  const separator = ' |'
  const fn =
    type === 'error'
      ? console.error
      : type === 'warn'
        ? console.warn
        : console.log
  fn(time, separator, ...msg)
}

const logger = {
  warn: (...msg: any[]) => {
    log('warn', ...msg)
  },
  error: (...msg: any[]) => {
    log('error', ...msg)
  },
  info: (...msg: any[]) => {
    log('info', ...msg)
  },
}

export default logger
