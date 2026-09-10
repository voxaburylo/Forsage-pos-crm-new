# Analytics responsive layout — 2026-09-10

## Scope

Presentation-only changes to daily/period sales reports, tire-service reports,
payroll and its operations dialog, statistics, staff profitability and ABC analysis.
No report arithmetic, stock, financial records, API methods or database schemas changed.

## Changes

- Opt-in AnalyticsLayout applies analytics-only responsive styles.
- Mobile tables become stacked records, with each value's column label retained.
- Full names and long automatic articles wrap within the screen.
- Mobile lists and payroll history no longer require nested scrolling.
- Date/month controls fit narrow viewports; form text is 16px on mobile.
- Main content and modal bodies can shrink correctly, with safe bottom padding.
- Desktop tables retain their headers and columns.
- Generic Table emits data-label attributes, with no visual change elsewhere.

## Verification

- Isolated Chromium fixture, blocked external requests and synthetic data only.
- 30 rows including long names/articles, large amounts and 30 payment records.
- Widths 320, 375, 430: all nine report tabs, payroll, staff profitability,
  ABC, statistics and payroll operations dialog.
- Checked horizontal bounds of visible controls/text/cells, main scrolling to
  bottom, bottom padding, modal scrolling, and absence of runtime errors.
- Desktop 1280px table header checked; mobile screenshot visually reviewed.
- Web tests: 436 passed across 60 files; typecheck and production build passed.
- Existing build warnings about chunk sizes remain; no new runtime errors found.
- Real iPhone Safari and real data were not used in these checks.

## Delivery

The owner explicitly approved publishing the earlier fixes together with this
analytics adaptation to the main GitHub branch. The earlier EXE build predates
this wider analytics adaptation; publishing source does not update that EXE.
