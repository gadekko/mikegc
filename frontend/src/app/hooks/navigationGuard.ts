/** Views with unsaved input can cancel a shell navigation before it starts. */
export function pushWithDraftGuard(
  router: { push: (href: string) => void },
  href: string,
): boolean {
  if (
    !window.dispatchEvent(
      new Event("mike:before-navigation", { cancelable: true }),
    )
  )
    return false;
  router.push(href);
  return true;
}
