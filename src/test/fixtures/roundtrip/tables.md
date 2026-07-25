# Release Checklist

The table below drove the 0.34.27 bug: commenting on a cell whose value
also appears in another cell used to anchor the wrong one.

| Stage    | Owner   | Status  | Notes                    |
| -------- | ------- | ------- | ------------------------ |
| Build    | CI      | green   | cached deps              |
| Test     | CI      | green   | 580 unit tests           |
| Package  | CI      | pending | vsix only                |
| Publish  | Ronica  | pending | needs a fresh PAT        |

Rows above reuse `green` and `pending` deliberately — duplicate cell
values must still anchor to the exact cell that was selected.

## Follow-ups

- Confirm the Package stage uploads the artifact
- Confirm the Publish stage is gated on a tag
