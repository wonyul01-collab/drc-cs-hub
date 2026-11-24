import { describe, expect, it, vi } from "vitest";
import { naverSources } from "../src/naver/sources.ts";

const token = () => new Response(JSON.stringify({ access_token: "t", expires_in: 10800 }));

describe("네이버 페이지 넘기기", () => {
  it("한 페이지 10건씩 와도 마지막 페이지까지 모두 가져온다", { timeout: 20000 }, async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) return token();
      const page = Number(new URL(url).searchParams.get("page"));
      const contents = Array.from({ length: page < 3 ? 10 : 4 }, (_, i) => ({ questionId: page * 100 + i, question: "사이즈?" }));
      return new Response(JSON.stringify({ contents, page, size: 10, totalElements: 24, totalPages: 3, last: page === 3 }));
    });
    const [qna] = naverSources({ clientId: "id", clientSecret: "$2a$04$abcdefghijklmnopqrstuu" }, fetchImpl);
    const { rows } = await qna.fetch(new Date(Date.now() - 86400e3), new Date());
    expect(rows).toHaveLength(24);
  });

  it("페이지 번호를 무시하고 같은 목록만 주면 멈춘다 (무한 반복 방지)", { timeout: 20000 }, async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2/token")) return token();
      return new Response(JSON.stringify({ contents: [{ questionId: 1, question: "q" }], size: 10 }));
    });
    const [qna] = naverSources({ clientId: "id", clientSecret: "$2a$04$abcdefghijklmnopqrstuu" }, fetchImpl);
    const { rows } = await qna.fetch(new Date(Date.now() - 86400e3), new Date());
    expect(rows).toHaveLength(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
