import { describe, expect, test } from "bun:test"
import { rrfFuse } from "./rrf"

describe("rrfFuse", () => {
  test("promotes an item that ranks well in both lists", () => {
    const fused = rrfFuse(
      [
        [
          { id: "a", item: "a" },
          { id: "b", item: "b" }
        ],
        [
          { id: "b", item: "b" },
          { id: "c", item: "c" }
        ]
      ],
      3
    )
    expect(fused[0]).toBe("b")
  })

  test("keeps dense-only hits when sparse is empty", () => {
    const fused = rrfFuse([[{ id: "only", item: "only" }], []], 5)
    expect(fused).toEqual(["only"])
  })
})
