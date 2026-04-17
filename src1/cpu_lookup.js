// cpu_lookup.js - MongoDB CPU database lookup
require('dotenv').config();
const { MongoClient } = require('mongodb');

let cachedClient = null;

/**
 * Get MongoDB client (cached)
 */
async function getMongoClient() {
  if (cachedClient) return cachedClient;
  
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI not found in environment');
  }
  
  cachedClient = new MongoClient(uri);
  await cachedClient.connect();
  return cachedClient;
}

/**
 * Parse CPU model string to extract searchable name
 * Example: "Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz" -> "i7-9700K"
 */
function parseCPUModel(modelString) {
  // Remove common prefixes/suffixes
  let cleaned = modelString
    .replace(/Intel\(R\)/gi, '')
    .replace(/Core\(TM\)/gi, '')
    .replace(/AMD\s+/gi, '')
    .replace(/Ryzen\s+/gi, 'Ryzen ')
    .replace(/CPU\s+@.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Extract processor number (e.g., "i7-9700K", "Ryzen 9 5950X")
  const match = cleaned.match(/(i[3579]-\d+[A-Z]*|Ryzen\s+\d+\s+\d+[A-Z]*|Xeon\s+[A-Z0-9-]+|Athlon\s+[A-Z0-9\s]+)/i);
  return match ? match[1].trim() : cleaned;
}

/**
 * Lookup CPU specs from MongoDB
 */
async function lookupCPU(cpuModel) {
  try {
    const client = await getMongoClient();
    const db = client.db('seve_requests');
    
    const searchTerm = parseCPUModel(cpuModel);
    console.log(`[CPU Lookup] Searching for: "${searchTerm}" (from "${cpuModel}")`);
    
    // Try Intel collections first
    let cpuData = await db.collection('intel_processors').findOne({
      $or: [
        { name: { $regex: searchTerm, $options: 'i' } },
        { processor_number: { $regex: searchTerm, $options: 'i' } }
      ]
    });
    
    if (cpuData) {
      console.log('[CPU Lookup] Found in intel_processors');
      return {
        success: true,
        source: 'intel_processors',
        data: cpuData
      };
    }
    
    // Try Intel Ark
    cpuData = await db.collection('intel_ark').findOne({
      $or: [
        { name: { $regex: searchTerm, $options: 'i' } },
        { processor_number: { $regex: searchTerm, $options: 'i' } }
      ]
    });
    
    if (cpuData) {
      console.log('[CPU Lookup] Found in intel_ark');
      return {
        success: true,
        source: 'intel_ark',
        data: cpuData
      };
    }
    
    // Try AMD collections
    cpuData = await db.collection('amd_processors').findOne({
      name: { $regex: searchTerm, $options: 'i' }
    });
    
    if (cpuData) {
      console.log('[CPU Lookup] Found in amd_processors');
      return {
        success: true,
        source: 'amd_processors',
        data: cpuData
      };
    }
    
    // Try AMD archive
    cpuData = await db.collection('amd_archive').findOne({
      name: { $regex: searchTerm, $options: 'i' }
    });
    
    if (cpuData) {
      console.log('[CPU Lookup] Found in amd_archive');
      return {
        success: true,
        source: 'amd_archive',
        data: cpuData
      };
    }
    
    console.log('[CPU Lookup] CPU not found in database');
    return {
      success: false,
      error: 'CPU not found in database'
    };
    
  } catch (err) {
    console.error('[CPU Lookup] Error:', err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Lookup CPU benchmark rating
 */
async function lookupBenchmark(cpuSKU) {
  try {
    const client = await getMongoClient();
    const db = client.db('seve_requests');
    
    const benchmark = await db.collection('cpu_benchmarks').findOne({
      sku: String(cpuSKU)
    });
    
    if (benchmark) {
      return {
        success: true,
        rating: parseInt(benchmark.rating, 10),
        url: benchmark.url
      };
    }
    
    return { success: false };
  } catch (err) {
    console.error('[Benchmark Lookup] Error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get comprehensive CPU information
 */
async function getCPUInfo(cpuModel) {
  const cpuLookup = await lookupCPU(cpuModel);
  
  if (!cpuLookup.success) {
    return cpuLookup;
  }
  
  const cpuData = cpuLookup.data;
  
  // Try to get benchmark if SKU available
  let benchmark = null;
  if (cpuData.sku) {
    const benchmarkResult = await lookupBenchmark(cpuData.sku);
    if (benchmarkResult.success) {
      benchmark = benchmarkResult;
    }
  }
  
  return {
    success: true,
    source: cpuLookup.source,
    cpu: {
      name: cpuData.name || cpuData.fullname,
      cores: parseInt(cpuData.cores, 10) || null,
      threads: parseInt(cpuData.threads, 10) || null,
      base_frequency: parseInt(cpuData.base_frequency, 10) || null,
      turbo_frequency: parseInt(cpuData.turbo_frequency, 10) || null,
      tdp: parseInt(cpuData.tdp, 10) || null,
      max_temp: parseInt(cpuData.max_temp, 10) || null,
      cache_size: parseInt(cpuData.cache_size || cpuData.cache_l3, 10) || null,
      lithography: parseInt(cpuData.lithography, 10) || null,
      launch_date: cpuData.launch_date,
      socket: cpuData.socket,
      status: cpuData.status,
      url: cpuData.url
    },
    benchmark: benchmark ? {
      rating: benchmark.rating,
      url: benchmark.url
    } : null
  };
}

/**
 * Close MongoDB connection
 */
async function closeConnection() {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
  }
}

module.exports = {
  getCPUInfo,
  lookupCPU,
  lookupBenchmark,
  closeConnection
};
