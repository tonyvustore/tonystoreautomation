export const TRANSITION_FULFILLMENT_TO_STATE_MUTATION = /* GraphQL */ `
  mutation TransitionFulfillmentToState($id: ID!, $state: String!) {
    transitionFulfillmentToState(id: $id, state: $state) {
      __typename
      ... on Fulfillment {
        id
        state
        method
        trackingCode
      }
      ... on FulfillmentStateTransitionError {
        errorCode
        message
        transitionError
      }
      ... on FulfillmentStateTransitionError {
        errorCode
        message
        transitionError
      }
    }
  }
`;

export const UPDATE_FULFILLMENT_TRACKING_MUTATION = /* GraphQL */ `
  mutation UpdateFulfillmentTracking($input: UpdateFulfillmentInput!) {
    updateFulfillment($input: $input) {
      __typename
      ... on Fulfillment {
        id
        state
        method
        trackingCode
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;
