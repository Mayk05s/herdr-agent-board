// A phone's keyboard over the board (models/phone-keyboard.ts): while it is up, <html> has
// data-keyboard, with what shows of the page above it in --vv-top and --vv-height, which the
// session sheet takes (styles/pwa.css). Only in a phone's browser with a finger (the board through
// serve or the domain, a narrow screen, a coarse pointer): on the computer and on a tablet nothing
// here runs.
import { useEffect } from 'react'
import { KeyboardWatch } from '../models/phone-keyboard.ts'
import { remotePage } from '../models/remote-page.ts'
import { useMediaQuery } from './useMediaQuery.ts'

/** A phone held in the hand: a narrow screen and a finger. */
export const PHONE_TOUCH_QUERY = '(max-width: 760px) and (pointer: coarse)'

/** Whether this page is a phone's, in the hand (what the keyboard's rules are for). */
export function usePhoneTouch(): boolean {
  return useMediaQuery(PHONE_TOUCH_QUERY) && remotePage()
}

/** Keeps <html>'s keyboard marks while this is a phone's page in the hand; returns whether it is. */
export function usePhoneKeyboard(): boolean {
  const phone = usePhoneTouch()
  useEffect(() => {
    const area = globalThis.visualViewport
    if (!phone || !area) return
    const root = document.documentElement
    const watch = new KeyboardWatch()
    const sync = () => {
      const view = watch.next(
        { width: area.width, height: area.height, offsetTop: area.offsetTop, scale: area.scale },
        { width: root.clientWidth, height: root.clientHeight },
      )
      root.style.setProperty('--vv-height', `${view.height}px`)
      root.style.setProperty('--vv-top', `${view.top}px`)
      root.toggleAttribute('data-keyboard', view.up)
    }
    sync()
    area.addEventListener('resize', sync)
    area.addEventListener('scroll', sync)
    return () => {
      area.removeEventListener('resize', sync)
      area.removeEventListener('scroll', sync)
      root.style.removeProperty('--vv-height')
      root.style.removeProperty('--vv-top')
      root.removeAttribute('data-keyboard')
    }
  }, [phone])
  return phone
}
