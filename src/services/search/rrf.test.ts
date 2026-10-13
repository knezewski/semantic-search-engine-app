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

  test("a zero weight drops the sparse channel entirely", () => {
    const fused = rrfFuse(
      [
        [
          { id: "a", item: "a" },
          { id: "b", item: "b" }
        ],
        [
          { id: "c", item: "c" },
          { id: "b", item: "b" }
        ]
      ],
      3,
      { weights: [1, 0] }
    )
    expect(fused).toEqual(["a", "b"])
  })

  test("down-weighting sparse lets dense dominate the tie", () => {
    const fused = rrfFuse(
      [
        [
          { id: "a", item: "a" },
          { id: "b", item: "b" }
        ],
        [
          { id: "b", item: "b" },
          { id: "a", item: "a" }
        ]
      ],
      2,
      { weights: [2, 1] }
    )
    expect(fused[0]).toBe("a")
  })
})
