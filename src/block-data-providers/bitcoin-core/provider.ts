import { ConfigService } from '@nestjs/config';
import { BitcoinCoreConfig } from '@/configuration.model';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
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
import {
    Block,
    BitcoinCoreOperationState,
    BlockTransaction,
    Transaction,
    Input,
    isCoinbaseInput,
    Output,
    RPCRequestBody,
} from '@/block-data-providers/bitcoin-core/interfaces';
import axios from 'axios';

@Injectable()
export class BitcoinCoreProvider
    extends BaseBlockDataProvider
    implements OnApplicationBootstrap
{
    protected readonly logger = new Logger(BitcoinCoreProvider.name);
    protected readonly operationStateKey = 'bitcoincore-operation-state';
    private isSyncing = false;
    private config: BitcoinCoreConfig;

    public client: Client;

    public constructor(
        private configService: ConfigService,
        indexerService: IndexerService,
        operationStateService: OperationStateService,
    ) {
        super(indexerService, operationStateService);
        this.config = this.configService.get<BitcoinCoreConfig>('bitcoinCore');
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
            this.logger.debug(
                `No new blocks found. Current tip height: ${tipHeight}`,
            );
            this.isSyncing = false;
            return;
        }

        let height = state.indexedBlockHeight + 1;

        for (height; height <= tipHeight; height++) {
            const transactions = await this.processBlock(height);
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
            state.indexedBlockHeight = height;
            await this.setState(state);
        }
        this.isSyncing = false;
    }

    async getTipHeight(): Promise<number> {
        try {
            const body = {
                method: 'getblockcount',
                params: [],
                ...this.createPartialRPCBody(),
            };
            return await this.request(body);
        } catch (error) {
            this.logger.log(`Error fetching block count`);
            throw error;
        }
    }

    async getBlockHash(height: number): Promise<string> {
        try {
            const body = {
                method: 'getblockhash',
                params: [height],
                ...this.createPartialRPCBody(),
            };
            return await this.request(body);
        } catch (error) {
            this.logger.log(`Error fetching  block hash of height : ${height}`);
            throw error;
        }
    }

    async getBlock(hash: string, verbosity: number): Promise<Block> {
        try {
            const body = {
                method: 'getblock',
                params: [hash, verbosity],
                ...this.createPartialRPCBody(),
            };
            return await this.request(body);
        } catch (error) {
            this.logger.log(`Error fetching block with block hash : ${hash}`);
            throw error;
        }
    }

    async getRawTransaction(
        txid: string,
        isVerbose: boolean,
    ): Promise<BlockTransaction> {
        try {
            const body = {
                method: 'getrawtransaction',
                params: [txid, isVerbose],
                ...this.createPartialRPCBody(),
            };
            return await this.request(body);
        } catch (error) {
            this.logger.log(
                `Error fetching transaction with transaction id : ${txid}`,
            );
            throw error;
        }
    }

    public async processBlock(height: number): Promise<Transaction[]> {
        const parsedTransactionList: Transaction[] = [];
        const blockHash = await this.getBlockHash(height);
        this.logger.log(
            `Processing block at height ${height}, hash ${blockHash}`,
        );
        const block = await this.getBlock(blockHash, 2);
        for (const txn of block.tx) {
            const parsedTransaction = await this.parseTransaction(
                txn,
                block.hash,
                block.height,
            );
            parsedTransactionList.push(parsedTransaction);
        }
        return parsedTransactionList;
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
            const prevTransaction = await this.getRawTransaction(
                txnInput.txid,
                true,
            );
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

    async request(body: RPCRequestBody): Promise<any> {
        const { rpcUser, rpcPass, rpcPort, rpcHost } = this.config;
        try {
            const response = await axios.post(
                `http://${rpcHost}:${rpcPort}/`,
                body,
                {
                    auth: {
                        username: rpcUser,
                        password: rpcPass,
                    },
                },
            );
            return response.data.result;
        } catch (error) {
            this.logger.error(
                `Request to BitcoinCore failed!\nRequest:\n${JSON.stringify(
                    body,
                )}\nError:\n${error.message}`,
            );
            throw error;
        }
    }

    createPartialRPCBody(): Pick<RPCRequestBody, 'jsonrpc' | 'id'> {
        return {
            jsonrpc: '1.0',
            id: 'silent_payment_indexer',
        };
    }
}
