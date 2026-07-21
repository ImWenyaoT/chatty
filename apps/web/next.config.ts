import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: ['@chatty/agent', '@chatty/contracts'],
}

export default nextConfig
