# Explanation proposal contract

Return one JSON object for one selected file:

```json
{
  "kind": "explanation",
  "path": "exact source path",
  "sections": [
    {
      "id": "section-1",
      "title": "Section title",
      "body": "Plain-language explanation",
      "startLine": 1,
      "endLine": 5
    }
  ]
}
```

Use one-based inclusive source lines. Describe intent, inputs, outputs, side effects and uncertainties. Explain specialized language syntax for someone unfamiliar with it. Keep the source unchanged. Use prose in the requested language, never HTML. For a block request, cover the requested block only. For a file request, cover the supplied file in reading order. Do not infer unsupplied code as fact.
