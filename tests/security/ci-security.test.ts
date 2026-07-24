import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryFile = (path: string) => new URL(`../../${path}`, import.meta.url);

describe("CI security guardrails", () => {
  it("pins every third-party action to a full commit SHA", async () => {
    const workflow = await readFile(repositoryFile(".github/workflows/ci.yml"), "utf8");
    const actionReferences = [...workflow.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/g)];

    expect(actionReferences).toHaveLength(4);
    for (const [, action, reference] of actionReferences) {
      expect(action).toMatch(/^(actions\/checkout|actions\/setup-node|pnpm\/action-setup)$/);
      expect(reference).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(workflow).not.toMatch(/uses:\s+[^@\s]+@v\d/);
  });

  it("audits production dependencies and scans tracked secret patterns", async () => {
    const workflow = await readFile(repositoryFile(".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("pnpm audit --prod --audit-level high");
    expect(workflow).toContain("(ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY");
    expect(workflow).toContain("gh[pousr]_[[:alnum:]_]{20,}");
    expect(workflow).toContain("github_pat_[[:alnum:]_]{20,}");
    expect(workflow).toContain(":(exclude)scripts/generate-dev-keys.mjs");
    expect(workflow).not.toContain(":(exclude)tests/**");
  });

  it("keeps vulnerable transitive versions out of the lockfile", async () => {
    const lockfile = await readFile(repositoryFile("pnpm-lock.yaml"), "utf8");

    expect(lockfile).not.toContain("fast-uri@3.1.3");
    expect(lockfile).not.toContain("fast-uri@4.1.0");
    expect(lockfile).not.toContain("find-my-way@9.6.0");
    expect(lockfile).toContain("fast-uri@3.1.4");
    expect(lockfile).toContain("fast-uri@4.1.1");
    expect(lockfile).toContain("find-my-way@9.7.0");
  });

  it("keeps local secrets and build outputs out of container contexts", async () => {
    const ignored = await readFile(repositoryFile(".dockerignore"), "utf8");

    for (const required of [
      ".git/",
      "node_modules/",
      "build/",
      "dist/",
      "work/",
      "outputs/",
      ".env*",
      "content/development/keys/",
      "coverage/"
    ]) {
      expect(ignored).toContain(required);
    }
  });
});
