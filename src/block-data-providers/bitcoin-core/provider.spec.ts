import { ConfigService } from '@nestjs/config';
import { BitcoinCoreProvider } from '@/block-data-providers/bitcoin-core/provider';
import {
    bitcoinCoreConfig,
    parsedTransactions,
} from '@/block-data-providers/bitcoin-core/provider-fixtures';
import { IndexerService } from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import {
    blockCountToHash,
    blocks,
    rawTransactions,
} from '@/block-data-providers/bitcoin-core/provider-fixtures';
describe('Bitcoincore Provider', () => {
    let provider: BitcoinCoreProvider;

    const BitcoinCoreClient = {
        getBlockCount: () => {
            return 3;
        },
        getBlockHash: (height: number) => {
            return blockCountToHash.get(height);
        },
        getBlock: (hash: string) => {
            return blocks.get(hash);
        },
        getRawTransaction: (hash: string) => {
            return rawTransactions.get(hash);
        },
    };

    beforeEach(async () => {
        const fakeConfigService = {
            get: (key: string) => {
                if (key == 'bitcoinCore') {
                    return bitcoinCoreConfig;
                }
                if (key == 'app.network') {
                    return 'regtest';
                }
                return null;
            },
        };
        provider = new BitcoinCoreProvider(
            fakeConfigService as unknown as ConfigService,
            {} as unknown as IndexerService,
            {} as unknown as OperationStateService,
        );
        provider.client = BitcoinCoreClient;
    });

    it('should process each transaction of a block appropriately', async () => {
        const result = await provider.processBlock(3);
        expect(result).toHaveLength(2);
        expect(result).toEqual(
            expect.arrayContaining([...parsedTransactions.values()]),
        );
    });
});
