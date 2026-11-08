import { describe, expect, it } from 'vitest'
import { History } from './history'

describe('History (undo/redo)', () => {
  it('starts with nothing to undo or redo', () => {
    const h = new History(0)
    expect(h.state).toBe(0)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })

  it('undoes and redoes a sequence of edits', () => {
    const h = new History('a')
    h.push('b')
    h.push('c')
    expect(h.state).toBe('c')
    expect(h.undo()).toBe('b')
    expect(h.undo()).toBe('a')
    expect(h.canUndo).toBe(false)
    expect(h.redo()).toBe('b')
    expect(h.redo()).toBe('c')
    expect(h.canRedo).toBe(false)
  })

  it('pushing after an undo clears the redo branch', () => {
    const h = new History('a')
    h.push('b')
    h.undo() // back to 'a'
    h.push('c') // new branch
    expect(h.state).toBe('c')
    expect(h.canRedo).toBe(false)
  })

  it('no-ops at the ends instead of throwing', () => {
    const h = new History(1)
    expect(h.undo()).toBe(1)
    expect(h.redo()).toBe(1)
  })

  it('respects the step limit', () => {
    const h = new History(0, { limit: 2 })
    h.push(1)
    h.push(2)
    h.push(3) // drops the oldest (0)
    expect(h.undo()).toBe(2)
    expect(h.undo()).toBe(1)
    expect(h.canUndo).toBe(false) // 0 was discarded
  })

  it('reset drops all history', () => {
    const h = new History('a')
    h.push('b')
    h.reset('z')
    expect(h.state).toBe('z')
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })
})
