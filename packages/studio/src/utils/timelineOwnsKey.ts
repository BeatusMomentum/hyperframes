export function timelineOwnsKey(event: Pick<KeyboardEvent, "target">): boolean {
  return event.target instanceof Element && event.target.closest("[data-studio-timeline]") !== null;
}
