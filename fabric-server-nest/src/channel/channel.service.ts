import { Injectable, BadRequestException } from '@nestjs/common';
import { ClientService } from '../client/client.service';
import { readFileSync } from 'fs';
import { ChannelRequest } from 'fabric-client';
import { join } from 'path';
@Injectable()
export class ChannelService {

    constructor(private readonly clientService: ClientService) { }

    public async createChannel(channelName: string, username: string, orgName: string) {
        console.log(`\n====== Creating Channel '${channelName}' ======\n`);
        try {
            // first setup the client for this org
            const client = await this.clientService.getClientForOrg(orgName);
            console.log(`Successfully got the fabric client for the organization ${orgName}`);

            // read in the envelope for the channel config raw bytes
            const envelope = readFileSync('/home/server/artifacts/channel/mychannel.tx');
            // extract the channel config bytes from the envelope to be signed
            const channelConfig = client.extractChannelConfig(envelope);

            // Acting as a client in the given organization provided with "orgName" param
            // sign the channel config bytes as "endorsement", this is required by
            // the orderer's channel creation policy
            // this will use the admin identity assigned to the client when the connection profile was loaded
            const signature = client.signChannelConfig(channelConfig);

            const request = {
                config: channelConfig,
                signatures: [signature],
                name: channelName,
                txId: client.newTransactionID(true) // get an admin based transactionID
            };

            // send to orderer
            const result = await client.createChannel(request as ChannelRequest);
            console.log(`result ::${result}`);
            if (result) {
                if (result.status === 'SUCCESS') {
                    console.log('Successfully created the channel.');
                    const response = {
                        success: true,
                        message: `Channel '${channelName}' created Successfully`,
                    };
                    return response;
                } else {
                    console.log(`Failed to create the channel. status: ${result.status} reason:${result.info}`);
                    const response = {
                        success: false,
                        message: `Channel '${channelName}' failed to create status: ${result.status} reason:${result.info}`,
                    };
                    return response;
                }
            } else {
                console.log(`\n!!!!!!!!! Failed to create the channel '${channelName}' !!!!!!!!!\n\n`);
                const response = {
                    success: false,
                    message: `Failed to create the channel '${channelName}'`,
                };
                return response;
            }
        } catch (err) {
            console.log(`Failed to initialize the channel: ${err.stack ? err.stack : err}`);
            throw new BadRequestException('Failed to initialize the channel: ' + err.toString());
        }
    }
    public async joinChannel(channelName: string, peers: string[], username: string, orgName: string) {
        console.log('\n\n============ Join Channel start ============\n')
        let errorMessage = null;
        let allEventHubs = [];
        try {
            console.log(`Calling peers in organization '${orgName}' to join the channel`);
            // first setup the client for this org
            const client = await this.clientService.getClientForOrg(orgName, username);
            console.log(`Successfully got the fabric client for the organization '${orgName}'`);
            const channel = client.getChannel(channelName);
            if (!channel) {
                const message = `Channel ${channelName} was not defined in the connection profile`;
                console.log(message);
                throw new BadRequestException(message);
            }
            // next step is to get the genesis_block from the orderer,
            // the starting point for the channel that we want to join
            const request = {
                txId: client.newTransactionID(true), // get an admin based transactionID
            };
            const genesisBlock = await channel.getGenesisBlock(request);
            // tell each peer to join and wait 10 seconds
            // for the channel to be created on each peer
            const promises = [];
            promises.push(new Promise(resolve => setTimeout(resolve, 10000)));
            const joinRequest = {
                targets: peers, // using the peer names which only is allowed when a connection profile is loaded
                txId: client.newTransactionID(true), // get an admin based transactionID
                block: genesisBlock,
            };
            const joinPromise = channel.joinChannel(joinRequest);
            promises.push(joinPromise);
            const results = await Promise.all(promises);
            console.log('Join Channel R E S P O N S E : %j', results);
            // lets check the results of sending to the peers which is
            // last in the results array
            const peersResults = results.pop();
            // then each peer results
            peersResults.forEach(result => {
                const peerResult = result;
                if (peerResult instanceof Error) {
                    errorMessage = `Failed to join peer to the channel with error :: ${peerResult.toString()}`;
                    console.log(errorMessage);
                } else if (peerResult.response && peerResult.response.status == 200) {
                    console.log(`Successfully joined peer to the channel ${channelName}`);
                } else {
                    errorMessage = `Failed to join peer to the channel ${channelName}`;
                    console.log(errorMessage);
                }
            });
        } catch (error) {
            console.log(`Failed to join channel due to error: ${error.stack ? error.stack : error}`);
            errorMessage = error.toString();
        }
        // need to shutdown open event streams
        allEventHubs.forEach(o => o.disconnect());

        if (!errorMessage) {
            const message = `Successfully joined peers in organization ${orgName} to the channel:${channelName}`;
            console.log(message);
            // build a response to send back to the REST caller
            const response = {
                success: true,
                message,
            };
            return response;
        } else {
            const message = `Failed to join all peers to channel.cause: ${errorMessage}`;
            console.log(message);
            // build a response to send back to the REST caller
            const response = {
                success: false,
                message,
            };
            return response;
        }
    }

    public async updateAnchorPeers(channelName: string, configUpdatePath: string, username: string, orgName: string) {
        console.log(`\n====== Updating Anchor Peers on '${channelName}' ======\n`);
        let errorMessage = null;
        try {
            // first setup the client for this org
            const client = await this.clientService.getClientForOrg(orgName, username);
            console.log(`Successfully got the fabric client for the organization '${orgName}'`);
            const channel = client.getChannel(channelName);
            if (!channel) {
                const message = `Channel ${channelName} was not defined in the connection profile`;
                console.error(message);
                throw new Error(message);
            }

            // read in the envelope for the channel config raw bytes
            const envelope = readFileSync(join('/home/server/artifacts/channel', configUpdatePath));
            // extract the channel config bytes from the envelope to be signed
            const channelConfig = client.extractChannelConfig(envelope);

            // Acting as a client in the given organization provided with "orgName" param
            // sign the channel config bytes as "endorsement", this is required by
            // the orderer's channel creation policy
            // this will use the admin identity assigned to the client when the connection profile was loaded
            const signature = client.signChannelConfig(channelConfig);

            const request = {
                config: channelConfig,
                signatures: [signature],
                name: channelName,
                txId: client.newTransactionID(true), // get an admin based transactionID
            };

            const promises = [];
            const eventHubs = channel.getChannelEventHubsForOrg();
            console.log(`found ${eventHubs.length} eventhubs for this organization ${orgName}`);
            eventHubs.forEach((eh) => {
                const anchorUpdateEventPromise = new Promise((resolve, reject) => {
                    console.log('anchorUpdateEventPromise - setting up event');
                    const eventTimeout = setTimeout(() => {
                        const message = 'REQUEST_TIMEOUT:' + eh.getPeerAddr();
                        console.log(message);
                        eh.disconnect();
                    }, 60000);
                    eh.registerBlockEvent((block) => {
                        console.log(`The config update has been committed on peer ${eh.getPeerAddr()}`);
                        clearTimeout(eventTimeout);
                        resolve();
                    }, (err) => {
                        clearTimeout(eventTimeout);
                        console.log(err);
                        reject(err);
                    },
                        // the default for 'unregister' is true for block listeners
                        // so no real need to set here, however for 'disconnect'
                        // the default is false as most event hubs are long running
                        // in this use case we are using it only once
                        { unregister: true, disconnect: true },
                    );
                    eh.connect();
                });
                promises.push(anchorUpdateEventPromise);
            });

            const sendPromise = client.updateChannel(request as ChannelRequest);
            // put the send to the orderer last so that the events get registered and
            // are ready for the orderering and committing
            promises.push(sendPromise);
            const results = await Promise.all(promises);
            console.log(`------->>> R E S P O N S E :${results}`);
            const response = results.pop(); //  orderer results are last in the results

            if (response) {
                if (response.status === 'SUCCESS') {
                    console.log(`Successfully update anchor peers to the channel ${channelName}`);
                } else {
                    errorMessage = `Failed to update anchor peers to the channel
                    ${channelName} with status: ${response.status} reason: ${response.info}`;
                    console.log(errorMessage);
                }
            } else {
                errorMessage = `Failed to update anchor peers to the channel ${channelName}`;
                console.log(errorMessage);
            }
        } catch (error) {
            console.error(error.toString());
            throw new BadRequestException('Failed to update anchor peers due to error: ' + error.stack ? error.stack : error);
        }

        if (!errorMessage) {
            const message = `Successfully update anchor peers in organization ${orgName} to the channel ${channelName}`;
            console.log(message);
            const response = {
                success: true,
                message,
            };
            return response;
        } else {
            const message = `Failed to update anchor peers. cause:${errorMessage}`;
            console.log(message);
            const response = {
                success: false,
                message,
            };
            return response;
        }

    }
}
