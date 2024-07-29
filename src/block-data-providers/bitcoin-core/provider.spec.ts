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

        jest.spyOn(provider, 'getTipHeight').mockImplementation(() => {
            return Promise.resolve(3);
        });
        jest.spyOn(provider, 'getBlockHash').mockImplementation(
            (height: number) => {
                return Promise.resolve(blockCountToHash.get(height));
            },
        );
        jest.spyOn(provider, 'getBlock').mockImplementation((hash: string) => {
            return Promise.resolve(blocks.get(hash));
        });
        jest.spyOn(provider, 'getRawTransaction').mockImplementation(
            (hash: string) => {
                return Promise.resolve(rawTransactions.get(hash));
            },
        );
    });

    it('should process each transaction of a block appropriately', async () => {
        const result = await provider.processBlock(3);
        expect(result).toHaveLength(2);
        expect(result).toEqual(
            expect.arrayContaining([...parsedTransactions.values()]),
        );
    });
});
