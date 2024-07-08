/* eslint-disable @typescript-eslint/no-unused-vars */
import {
    blockCountToHash,
    blocks,
    rawTransactions,
} from '@/block-providers/providers/bitcoin-core/provider-fixtures';

export const BitcoinCoreClient = {
    getBlockCount: () => {
        return 3;
    },
    getBlockHash: (height: number, _verbosity: number) => {
        return blockCountToHash.get(height);
    },
    getBlock: (hash: string) => {
        return blocks.get(hash);
    },
    getRawTransaction: (hash: string, _verbosity: boolean) => {
        return rawTransactions.get(hash);
    },
};
