import fs from 'node:fs'
import path from 'node:path'

export interface Account {
  id: string
  name: string
  color: string
  createdAt: number
  lastActiveAt: number
}

const PALETTE = [
  '#3370ff', '#00b578', '#ff8f1f', '#f53f3f',
  '#722ed1', '#13c2c2', '#eb2f96', '#faad14'
]

export class AccountStore {
  private file: string
  accounts: Account[] = []

  constructor(dir: string) {
    this.file = path.join(dir, 'accounts.json')
    this.load()
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.accounts = JSON.parse(raw)
    } catch {
      this.accounts = []
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.accounts, null, 2))
    fs.renameSync(tmp, this.file)
  }

  add(name: string): Account {
    const acc: Account = {
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim() || `账号 ${this.accounts.length + 1}`,
      color: PALETTE[this.accounts.length % PALETTE.length],
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    }
    this.accounts.push(acc)
    this.save()
    return acc
  }

  rename(id: string, name: string): void {
    const acc = this.accounts.find((a) => a.id === id)
    if (acc && name.trim()) {
      acc.name = name.trim()
      this.save()
    }
  }

  touch(id: string): void {
    const acc = this.accounts.find((a) => a.id === id)
    if (acc) {
      acc.lastActiveAt = Date.now()
      this.save()
    }
  }

  remove(id: string): void {
    this.accounts = this.accounts.filter((a) => a.id !== id)
    this.save()
  }
}
