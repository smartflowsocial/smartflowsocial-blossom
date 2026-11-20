# Changelog

## 1.0.0-rc.1 — 2026-11-20

Prerelease for the coordinated SmartFlowSocial v1.0.0-rc.1. This is not stable `1.0.0`.

- The package version is `1.0.0-rc.1`.
- A prerelease image tag does not move `latest`, `1`, or `1.0`.
- Image provenance uses the digest of the image that was pushed. A hash of the Dockerfile and
  lockfile is not an image digest.
- The release security workflow scans the production image and does not deploy the live Blossom
  service.
- The runtime image no longer contains the base image's npm tree. That tree carried
  `brace-expansion` 5.0.9 and `undici` 6.28.0. The production lockfile does not depend on those
  copies.
- The image scan still reports Debian 12 packages that have no fixed version. It does not ignore a
  finding that has a fix.

## 1.0.0

The package version was `1.0.0` before this candidate. That string was not published as GitHub
Release `v1.0.0`. The published prerelease remains `v1.0.0-beta.1`.
