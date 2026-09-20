/** Well known values with autocomplete, any string is accepted. */
export type GenAiProviderName =
  | 'openai'
  | 'anthropic'
  | 'aws.bedrock'
  | 'azure.ai.openai'
  | 'azure.ai.inference'
  | 'gcp.gemini'
  | 'gcp.vertex_ai'
  | 'gcp.gen_ai'
  | 'groq'
  | 'mistral_ai'
  | 'deepseek'
  | 'x_ai'
  | 'cohere'
  | 'perplexity'
  | 'ibm.watsonx.ai'
  | 'moonshot_ai'
  | (string & {});
