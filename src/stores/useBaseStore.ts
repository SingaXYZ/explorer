import { defineStore } from 'pinia';
import { useBlockchain } from '@/stores';
import { decodeTxRaw, type DecodedTxRaw } from '@cosmjs/proto-signing';
import dayjs from 'dayjs';
import type { Block } from '@/types';
import { hashTx } from '@/libs';
import { fromBase64 } from '@cosmjs/encoding';

const FETCH_ALL_BLOCKS = import.meta.env.VITE_FETCH_ALL_BLOCKS || false;
const RECENT_BLOCKS_LIMIT = import.meta.env.VITE_RECENT_BLOCK_LIMIT || 50;
// Number of historical blocks to backfill on a cold start (e.g. page refresh) so the
// recent-blocks / recent-txs views are populated immediately instead of growing one
// block per polling interval. Defaults to the recent-blocks window size.
const INITIAL_BLOCK_SEED = Number(import.meta.env.VITE_INITIAL_BLOCK_SEED) || Number(RECENT_BLOCKS_LIMIT) || 50;
// Max number of historical blocks fetched in parallel while seeding. Keep it modest to
// avoid rate limiting on public nodes; raise it for private/high-throughput endpoints.
const SEED_CONCURRENCY = Math.max(1, Number(import.meta.env.VITE_SEED_CONCURRENCY) || 5);

// Prevents overlapping seed backfills when polls fire while a seed is still running.
let seedingInFlight = false;

export const useBaseStore = defineStore('baseStore', {
  state: () => {
    return {
      earliest: {} as Block,
      latest: {} as Block,
      recents: [] as Block[],
      theme: (window.localStorage.getItem('theme') || 'dark') as 'light' | 'dark',
      connected: false,
    };
  },
  getters: {
    blocktime(): number {
      if (this.earliest && this.latest) {
        if (this.latest.block?.header?.height !== this.earliest.block?.header?.height) {
          const diff = dayjs(this.latest.block?.header?.time).diff(this.earliest.block?.header?.time);
          const blocks = Number(this.latest.block.header.height) - Number(this.earliest.block.header.height);
          return Math.round(diff / blocks);
        }
      }
      return 1000; // better to start low and increase
    },
    blockchain() {
      return useBlockchain();
    },
    hasRpc(): boolean {
      return this.blockchain?.rpc as unknown as boolean;
    },
    currentChainId(): string {
      return this.latest.block?.header.chain_id || '';
    },
    txsInRecents() {
      const txs = [] as {
        height: string;
        hash: string;
        tx: DecodedTxRaw;
      }[];
      this.recents.forEach((b) =>
        b.block?.data?.txs.forEach((tx: string) => {
          if (tx) {
            const raw = fromBase64(tx);
            try {
              txs.push({
                height: b.block.header.height,
                hash: hashTx(raw),
                tx: decodeTxRaw(raw),
              });
            } catch (e) {
              console.error(e);
            }
          }
        })
      );
      return txs.sort((a, b) => {
        return Number(b.height) - Number(a.height);
      });
    },
  },
  actions: {
    async initial() {
      while (!this.hasRpc) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      this.fetchLatest();
    },
    async clearRecentBlocks() {
      this.recents = [];
    },
    async fetchLatest() {
      if (!this.hasRpc) return this.latest;
      try {
        this.latest = await this.blockchain.rpc?.getBaseBlockLatest();
        this.connected = true;
      } catch (error) {
        console.error('Error fetching latest block:', error);
        this.connected = false;
      }
      if (!this.earliest || this.earliest?.block?.header?.chain_id != this.latest?.block?.header?.chain_id) {
        //reset earliest and recents
        this.earliest = this.latest;
        this.recents = [];
      }
      // A seed backfill is already running; let it finish before mutating recents.
      if (seedingInFlight) return this.latest;
      //check if the block exists in recents
      if (this.recents.findIndex((x) => x?.block_id?.hash === this.latest?.block_id?.hash) === -1) {
        if (this.recents.length === 0) {
          // Cold start (e.g. page refresh): backfill the recent window, rendering each
          // block as it arrives instead of waiting for the whole window to load.
          seedingInFlight = true;
          try {
            await this.seedRecentBlocks();
          } finally {
            seedingInFlight = false;
          }
        } else {
          const newBlocks = await this.fetchNewBlocks();
          const combined = [...this.recents, ...newBlocks];
          this.recents = combined.slice(-RECENT_BLOCKS_LIMIT);
        }
      }
      return this.latest;
    },
    /**
     * Fetches all blocks since the last block in recents.
     * Only fetches blocks with height greater than this.recents[-1].block.header.height.
     * Returns an array of new blocks to be added to recents.
     */
    async fetchNewBlocks() {
      if (!this.latest?.block?.header?.height) return [];
      if (!FETCH_ALL_BLOCKS) return [this.latest];
      const oldHeight = Number(this.recents[this.recents.length - 1]?.block?.header?.height);
      const newHeight = Number(this.latest.block.header.height);
      let newBlocks = [];
      // Fetch all blocks between oldHeight+1 and less than newHeight
      for (let h = oldHeight + 1; h < newHeight; h++) {
        const block = await this.fetchBlock(h);
        if (!block?.block?.header?.height) continue; // skip if block not found
        newBlocks.push(block);
      }
      // Add the latest block
      newBlocks.push(this.latest);
      return newBlocks;
    },
    /**
     * Backfills the most recent blocks after a cold start (page refresh / chain switch)
     * so the block/tx views don't stay empty. The latest block is shown immediately, then
     * older blocks are fetched concurrently (bounded by SEED_CONCURRENCY) and each is
     * inserted into recents by height as soon as it arrives — so blocks render one by one
     * as they land, out of fetch order but always kept in ascending height order. Skips
     * any height that fails without aborting the seed.
     */
    async seedRecentBlocks(): Promise<void> {
      const latestHeight = Number(this.latest?.block?.header?.height);
      if (!latestHeight) return;
      const seedCount = Math.min(Number(RECENT_BLOCKS_LIMIT) || 50, INITIAL_BLOCK_SEED);
      const start = Math.max(1, latestHeight - seedCount + 1);

      // Show the latest block right away; older blocks fill in as they arrive.
      this.recents = [this.latest];
      this.earliest = this.latest;

      // Inserts a block into recents keeping ascending height order (dedup + cap).
      const insert = (block: Block) => {
        const height = Number(block?.block?.header?.height);
        if (!height || this.recents.some((b) => Number(b?.block?.header?.height) === height)) return;
        const next = [...this.recents];
        let idx = next.findIndex((b) => Number(b?.block?.header?.height) > height);
        if (idx === -1) idx = next.length;
        next.splice(idx, 0, block);
        this.recents = next.slice(-RECENT_BLOCKS_LIMIT);
        this.earliest = this.recents[0]; // oldest in window → accurate blocktime
      };

      // Backfill newest-first so nearer history tends to appear soonest.
      const heights: number[] = [];
      for (let h = latestHeight - 1; h >= start; h--) heights.push(h);

      // Bounded worker pool: `cursor` is safe to share since it only advances between awaits.
      let cursor = 0;
      const worker = async () => {
        while (cursor < heights.length) {
          const h = heights[cursor++];
          try {
            const block = await this.fetchBlock(h);
            if (block?.block?.header?.height) insert(block);
          } catch (error) {
            console.error(`Error seeding block ${h}:`, error);
          }
        }
      };
      const poolSize = Math.min(SEED_CONCURRENCY, heights.length);
      await Promise.all(Array.from({ length: poolSize }, () => worker()));
    },
    async fetchValidatorByHeight(height?: number, offset = 0) {
      return this.blockchain.rpc.getBaseValidatorsetAt(String(height), offset);
    },
    async fetchLatestValidators(offset = 0) {
      return this.blockchain.rpc.getBaseValidatorsetLatest(offset);
    },
    async fetchBlock(height?: number | string) {
      try {
        const block = await this.blockchain.rpc.getBaseBlockAt(String(height));
        this.connected = true;
        return block;
      } catch (error) {
        console.error('Error fetching latest block:', error);
        this.connected = false;
      }
      return {} as Block;
    },
    async fetchAbciInfo() {
      return this.blockchain.rpc.getBaseNodeInfo();
    },
    // async fetchNodeInfo() {
    //     return this.blockchain.rpc.no()
    // }
  },
});
