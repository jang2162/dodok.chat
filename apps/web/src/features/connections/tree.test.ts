import { describe, expect, it } from "vitest";
import { makeAgent } from "../../../test/agentsPage";
import { projectOf, runnerId } from "../../../test/runnersServer";
import { buildConnectionTree, type TreeGateway, type TreeInput, type TreeRunner } from "./tree";

const G1 = "01a00000-0000-7000-8000-0000000000a1";
const G2 = "01a00000-0000-7000-8000-0000000000a2";
const R1 = runnerId(1);

const base = (over: Partial<TreeInput> = {}): TreeInput => ({
  agents: [],
  gateways: [],
  runners: null,
  projects: null,
  meId: null,
  ...over,
});
const gw = (id: string, name: string, ownerUserId: string | null = null) => ({
  id,
  name,
  state: "연결됨" as const,
  ownerUserId,
});
const coder = (over: Parameters<typeof makeAgent>[0] extends infer F ? Partial<F> : never = {}) =>
  makeAgent({
    provider: "runner",
    providerAgentId: "r-coder",
    handle: "coder",
    name: "Coder",
    runner: { tokenId: R1, label: "mia 의 맥북", revoked: false },
    ...over,
  });

const byId = <T extends { id: string }>(list: readonly T[], id: string) => list.find((n) => n.id === id);

describe("buildConnectionTree", () => {
  it("groups OpenClaw agents under their gateway", () => {
    const dev = makeAgent({
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gateway: { id: G1, name: "사무실" },
    });
    const fin = makeAgent({
      providerAgentId: "fin",
      handle: "fin",
      name: "Fin",
      gateway: { id: G1, name: "사무실" },
    });
    const tree = buildConnectionTree(base({ agents: [dev, fin], gateways: [gw(G1, "사무실")] }));
    const node = tree.others[0] as TreeGateway;
    expect(node.kind).toBe("gateway");
    expect(node.agents.map((a) => a.agent.handle)).toEqual(["dev", "fin"]);
  });

  it("shows gateways with no agents", () => {
    const tree = buildConnectionTree(base({ gateways: [gw(G1, "사무실"), gw(G2, "집")] }));
    expect(tree.others.map((n) => n.id)).toEqual([G1, G2]);
  });

  it("nests runner agents under project when projects are known", () => {
    const p1 = { id: projectOf(1).id, runnerId: R1, label: "dodok", archived: false };
    const agent = coder({
      runnerAgent: {
        projectId: p1.id,
        disallowedTools: [],
      },
    });
    const tree = buildConnectionTree(
      base({
        agents: [agent],
        runners: [{ id: R1, label: "mia 의 맥북", state: "연결됨" }],
        projects: [p1],
      }),
    );
    const node = byId(tree.others, R1) as TreeRunner;
    expect(node.projects[0]?.label).toBe("dodok");
    expect(node.projects[0]?.agents.map((a) => a.agent.handle)).toEqual(["coder"]);
    expect(node.agents).toEqual([]);
  });

  it("hangs runner agents directly under runner when projects are unknown", () => {
    const tree = buildConnectionTree(
      base({ agents: [coder()], runners: [{ id: R1, label: "mia 의 맥북", state: "연결됨" }] }),
    );
    const node = byId(tree.others, R1) as TreeRunner;
    expect(node.projects).toEqual([]);
    expect(node.agents.map((a) => a.agent.handle)).toEqual(["coder"]);
  });

  it("derives runners from agents when the runner list is unknown", () => {
    const tree = buildConnectionTree(base({ agents: [coder()] }));
    const node = byId(tree.others, R1) as TreeRunner;
    expect(node).toMatchObject({ kind: "runner", id: R1, label: "mia 의 맥북", state: null });
    const revoked = buildConnectionTree(
      base({ agents: [coder({ runner: { tokenId: R1, label: "mia 의 맥북", revoked: true } })] }),
    );
    expect((byId(revoked.others, R1) as TreeRunner).state).toBe("폐기됨");
  });

  it("puts agents without a connection in orphaned", () => {
    const lost = makeAgent({ providerAgentId: "old", handle: "old", name: "Old", gateway: null });
    const unbound = makeAgent({ provider: "runner", providerAgentId: "r-x", handle: "x", name: "X" });
    const revoked = coder({ handle: "rev", runner: { tokenId: R1, label: "mia 의 맥북", revoked: true } });
    const tree = buildConnectionTree(
      base({
        agents: [lost, unbound, revoked],
        runners: [{ id: R1, label: "mia 의 맥북", state: "폐기됨" }],
      }),
    );
    expect(tree.orphaned.map((a) => a.agent.handle)).toEqual(["old", "x", "rev"]);
    expect((byId(tree.others, R1) as TreeRunner).agents).toEqual([]);
  });

  it("puts archived agents in archived only", () => {
    const gone = makeAgent({
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gateway: { id: G1, name: "사무실" },
      archivedAt: "2026-10-05T00:00:00.000Z",
    });
    const tree = buildConnectionTree(base({ agents: [gone], gateways: [gw(G1, "사무실")] }));
    expect((tree.others[0] as TreeGateway).agents).toEqual([]);
    expect(tree.orphaned).toEqual([]);
    expect(tree.archived.map((a) => a.handle)).toEqual(["dev"]);
  });

  it("splits mine and others by ownerUserId when meId is set", () => {
    const tree = buildConnectionTree(
      base({ gateways: [gw(G1, "사무실", "u1"), gw(G2, "집", "u2")], meId: "u1" }),
    );
    expect(tree.mine.map((n) => n.id)).toEqual([G1]);
    expect(tree.others.map((n) => n.id)).toEqual([G2]);
  });
});
