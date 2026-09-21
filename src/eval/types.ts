interface EvalDocument {
  id: string
  title: string
  text: string
  source?: string
}

interface EvalQuery {
  id: string
  query: string
  relevantDocumentIds: string[]
  relevantChunkIds?: string[]
}

export type { EvalDocument, EvalQuery }
