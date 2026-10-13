import { screen, within } from '@testing-library/react'

/** The rows of one group in the session list, found by the group's visible heading. */
export function rowsOf(group: string): HTMLElement[] {
  const section = screen.getByRole('heading', { level: 2, name: group }).closest('section')!
  return within(section).getAllByRole('listitem')
}

/** The visible group headings of the session list (the page's level-2 headings). */
export function listGroups(): (string | null)[] {
  return screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
}
