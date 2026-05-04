## Raw path placeholders

`{+param}` preserves `/` separators inside a path value while still percent-encoding each segment.

Accepted example:

- `path: jobs/notifications with space`
- Result: `/jobs/notifications%20with%20space`

Safety rules:

- Segments must be non-empty.
- Segments must not be `.`.
- Segments must not be `..`.
- The matching param must be `required: true`, or it must define a safe non-empty `default`.

Rejected examples:

- `../admin`
- `a/../../admin`
- `a//admin`
- omitted optional param with no default

These rules prevent URL canonicalization from escaping the configured prefix. For example, `http://host/api/{+path}` must never be able to resolve to `http://host/admin`.
