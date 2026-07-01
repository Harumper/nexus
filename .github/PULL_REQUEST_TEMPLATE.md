<!--
Thanks for contributing! Keep PRs focused (one topic). Explain the *why*, not just
the *what*. See CONTRIBUTING.md.
-->

## What & why

What this changes, and the reasoning behind it.

## Related issue

Closes #

## Checklist

- [ ] Focused on a single topic
- [ ] Tests added/updated where relevant (backend e2e suite and/or Go tests)
- [ ] `backend`: `npx tsc --noEmit` and `npm run test` pass
- [ ] `agent`: `go vet ./...` and `go test ./...` pass (if Go changed)
- [ ] `frontend`: `npx tsc --noEmit` and `npm run build` pass (if frontend changed)
- [ ] If it touches enrollment, the agent↔backend channel, sudoers/privhelper,
      RBAC, SSRF, or auth: I read [`THREAT-MODEL.md`](THREAT-MODEL.md) and kept its
      invariants
- [ ] I understand that opening this PR implies acceptance of the [`CLA.md`](CLA.md)

<!--
Note: Nexus develops on an upstream GitLab (CI + review). Your PR is integrated
there and mirrored back to GitHub, so it may land as a commit rather than a merged
GitHub PR. Your authorship is preserved.
-->
