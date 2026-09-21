import { describe, expect, test } from "bun:test"
import { chunkText, splitDocument, windowTokenIds } from "./chunk"
import { createDocumentRecord } from "./document"
import type { TokenizerPort } from "./tokenizer"

class WordTokenizer implements TokenizerPort {
  readonly modelId = "words"
  private words: string[] = []

  async encode(text: string): Promise<number[]> {
    this.words = text.trim().split(/\s+/).filter(Boolean)
    return this.words.map((_, index) => index)
  }

  async decode(tokenIds: number[]): Promise<string> {
    return tokenIds
      .map(id => this.words[id] ?? "")
      .filter(Boolean)
      .join(" ")
  }
}

const words = { tokenizer: new WordTokenizer() }

describe("windowTokenIds", () => {
  test("returns a single window when the sequence fits", () => {
    expect(windowTokenIds([1, 2, 3], 8, 2)).toEqual([[1, 2, 3]])
  })

  test("slides by size minus overlap", () => {
    expect(windowTokenIds([1, 2, 3, 4, 5], 3, 1)).toEqual([
      [1, 2, 3],
      [3, 4, 5]
    ])
  })
})

describe("chunkText", () => {
  test("returns an empty list for blank input", async () => {
    expect(await chunkText("   ", words)).toEqual([])
  })

  test("keeps a short document as a single chunk", async () => {
    expect(await chunkText("A short column.", { ...words, chunkSize: 8, chunkOverlap: 1 })).toEqual(["A short column."])
  })

  test("splits on token windows and keeps overlap words", async () => {
    const chunks = await chunkText("one two three four five six", {
      ...words,
      chunkSize: 3,
      chunkOverlap: 1
    })
    expect(chunks[0]).toBe("one two three")
    expect(chunks[1]).toBe("three four five")
    expect(chunks[2]).toBe("five six")
  })

  test("rejects overlap that is not smaller than chunk size", async () => {
    await expect(chunkText("hello", { ...words, chunkSize: 10, chunkOverlap: 10 })).rejects.toThrow()
  })
})

describe("splitDocument", () => {
  test("assigns deterministic chunk ids", async () => {
    const document = createDocumentRecord({
      id: "11111111-1111-1111-1111-111111111111",
      title: "Column",
      text: "alpha beta gamma delta epsilon",
      source: "papers/one.md"
    })

    const first = await splitDocument(document, { ...words, chunkSize: 3, chunkOverlap: 1 })
    const second = await splitDocument(document, { ...words, chunkSize: 3, chunkOverlap: 1 })

    expect(first.length).toBeGreaterThan(0)
    expect(first.map(chunk => chunk.chunkId)).toEqual(second.map(chunk => chunk.chunkId))
    expect(first[0]?.chunkId).toBe(`${document.id}:chunk-0`)
    expect(first[0]?.documentId).toBe(document.id)
    expect(first[0]?.title).toBe("Column")
    expect(first[0]?.source).toBe("papers/one.md")
  })
})
