import { ConfigService } from '@nestjs/config';
import * as Client from 'bitcoin-core';
import { BitcoinCoreConfig } from '@/configuration.model';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import {
    Block,
    BlockTransaction,
    Input,
    isCoinbaseInput,
    Output,
} from '@/block-data-providers/bitcoin-core/interfaces';
import { BitcoinNetwork } from '@/common/enum';
import { TAPROOT_ACTIVATION_HEIGHT } from '@/common/constants';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
    IndexerService,
    TransactionInput,
    TransactionOutput,
} from '@/indexer/indexer.service';
import { OperationStateService } from '@/operation-state/operation-state.service';
import { BaseBlockDataProvider } from '@/block-data-providers/base-block-data-provider.abstract';

type BitcoinCoreOperationState = {
    currentBlockHeight: number;
    indexedBlockHeight: number;
};

type Transaction = {
    txid: string;
    vin: TransactionInput[];
    vout: TransactionOutput[];
    blockHeight: number;
    blockHash: string;
};

@Injectable()
export class BitcoinCoreProvider
    extends BaseBlockDataProvider
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(BitcoinCoreProvider.name);
    protected readonly operationStateKey = 'bitcoincore-operation-state';
    private readonly baseUrl: string;
    private isSyncing = false;
    public START_BLOCK = 0;
    private config: BitcoinCoreConfig;

    public client: Client;

    public constructor(
        private configService: ConfigService,
        indexerService: IndexerService,
        operationStateService: OperationStateService,
    ) {
        super(indexerService, operationStateService);
        const config = this.configService.get<BitcoinCoreConfig>('bitcoincore');
        this.client = new Client({
            network: config.network,
            host: config.rpchost,
            password: config.rpcpass,
            port: config.rpcport,
            username: config.rpcuser,
        });
    }

    async onApplicationBootstrap() {
        const getState = await this.getState();
        if (getState) {
            this.logger.log(
                `Restoring state from previous run: ${JSON.stringify(
                    getState,
                )}`,
            );
        } else {
            this.logger.log('No previous state found. Starting from scratch.');
            const state: BitcoinCoreOperationState = {
                currentBlockHeight: 0,
                indexedBlockHeight:
                    this.configService.get<BitcoinNetwork>('app.network') ===
                    BitcoinNetwork.MAINNET
                        ? TAPROOT_ACTIVATION_HEIGHT - 1
                        : 0,
            };
            await this.setState(state);
        }
    }

    @Cron(CronExpression.EVERY_10_SECONDS)
    async sync() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const state = await this.getState();
        if (!state) {
            throw new Error('State not found');
        }

        const tipHeight = await this.getTipHeight();
        if (tipHeight <= state.indexedBlockHeight) {
            this.logger.log(
                `No new blocks found. Current tip height: ${tipHeight}`,
            );
            this.isSyncing = false;
            return;
        }

        const height = state.indexedBlockHeight + 1;
        const transactions = await this.getTransactions(height);
        state.indexedBlockHeight = height;
        this.isSyncing = false;
        for (const transaction of transactions) {
            const { txid, vin, vout, blockHeight, blockHash } = transaction;
            await this.indexTransaction(
                txid,
                vin,
                vout,
                blockHeight,
                blockHash,
            );
        }
        await this.setState(state);
    }

    protected async getTipHeight(): Promise<number> {
        return await this.client.getBlockCount();
    }

    private async getTransactions(height: number): Promise<Transaction[]> {
        const latestBlock = await this.getTipHeight();
        const paredTransactionList: Transaction[] = [];
        for (let i = height; i <= latestBlock; i++) {
            const blockHash: string = await this.client.getBlockHash(i);
            const block: Block = await this.client.getBlock(blockHash, 2);
            for (const txn of block.tx) {
                const parsedTransaction = await this.parseTransaction(
                    txn,
                    block.hash,
                    block.height,
                );
                paredTransactionList.push(parsedTransaction);
            }
        }
        return paredTransactionList;
    }

    private async parseTransaction(
        txn: BlockTransaction,
        blockHash: string,
        blockHeight: number,
    ): Promise<Transaction> {
        const inputs: TransactionInput[] = await Promise.all(
            txn.vin.map(
                async (input) => await this.parseTransactionInput(input),
            ),
        );
        const outputs: TransactionOutput[] = txn.vout.map((output) =>
            this.parseTransactionOutput(output),
        );

        return {
            txid: txn.txid,
            vin: inputs,
            vout: outputs,
            blockHeight,
            blockHash,
        };
    }

    private async parseTransactionInput(
        txnInput: Input,
    ): Promise<TransactionInput> {
        let txid =
            '0000000000000000000000000000000000000000000000000000000000000000';
        let vout = 0;
        let prevOutScript = '';
        let witness = undefined;
        let scriptSig = '';

        if (!isCoinbaseInput(txnInput)) {
            txid = txnInput.txid;
            const prevTransaction: BlockTransaction =
                await this.client.getRawTransaction(txnInput.txid, true);
            vout = txnInput.vout;
            prevOutScript = prevTransaction.vout.find((out) => out.n == vout)
                .scriptPubKey.hex;
            witness = txnInput.txinwitness;
            scriptSig = txnInput.scriptSig.hex;
        }

        return {
            txid,
            vout,
            scriptSig,
            witness,
            prevOutScript,
        };
    }

    private parseTransactionOutput(txnOutput: Output): TransactionOutput {
        return {
            scriptPubKey: txnOutput.scriptPubKey.hex,
            value: txnOutput.value,
        };
    }
}
